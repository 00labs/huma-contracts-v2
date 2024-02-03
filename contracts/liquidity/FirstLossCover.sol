// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Errors} from "../common/Errors.sol";
import {FirstLossCoverStorage} from "./FirstLossCoverStorage.sol";
import {PoolConfig, PoolSettings, FirstLossCoverConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title FirstLossCover
 */
contract FirstLossCover is
    ERC20Upgradeable,
    PoolConfigCache,
    FirstLossCoverStorage,
    IFirstLossCover
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// The maximum number of cover providers that can supply assets to the first loss cover.
    uint256 private constant MAX_ALLOWED_NUM_PROVIDERS = 100;

    /**
     * @notice A cover provider has been added.
     * @param account The address of the newly added cover provider.
     */
    event CoverProviderAdded(address indexed account);
    /**
     * @notice A cover provider has been removed.
     * @param account The address of the newly removed cover provider.
     */
    event CoverProviderRemoved(address indexed account);

    /**
     * @notice Loss has been covered by the first loss cover.
     * @param covered The amount covered by the first loss cover.
     * @param remaining The remaining amount of loss that the first loss cover was not able to cover.
     * @param coveredLoss The cumulative amount of loss covered so far.
     */
    event LossCovered(uint256 covered, uint256 remaining, uint256 coveredLoss);
    /**
     * @notice Loss recovery has been distributed to the first loss cover.
     * @param recovered The amount of loss recovery distributed.
     * @param coveredLoss The cumulative amount of loss covered after the recovery was applied.
     */
    event LossRecovered(uint256 recovered, uint256 coveredLoss);

    /**
     * @notice A cover provider has deposited assets into the first loss cover.
     * @param account The address of the cover provider.
     * @param assets The amount of assets deposited by the cover provider.
     * @param shares The number of shares received by the cover provider.
     */
    event CoverDeposited(address indexed account, uint256 assets, uint256 shares);
    /**
     * @notice Assets has been redeemed and withdrawn from the first loss cover.
     * @param by The address that initiated the redemption.
     * @param receiver The receiver of the redeemed assets.
     * @param shares The number of shares burned by the redeemer.
     * @param assets The amount of assets redeemed by the redeemer.
     */
    event CoverRedeemed(
        address indexed by,
        address indexed receiver,
        uint256 shares,
        uint256 assets
    );
    /**
     * @notice Assets has been added to the first loss cover.
     * @param assets The amount of assets added.
     */
    event AssetsAdded(uint256 assets);

    /**
     * @notice Yield has been paid out to the cover providers.
     * @param account The address of the cover provider that received the yield.
     * @param yields The amount of yield paid out to the cover provider.
     */
    event YieldPaidOut(address indexed account, uint256 yields);

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig
    ) external initializer {
        __ERC20_init(name, symbol);
        __UUPSUpgradeable_init();
        _initialize(_poolConfig);
    }

    function addCoverProvider(address account) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.ZeroAddressProvided();

        if (_coverProviders.length() >= MAX_ALLOWED_NUM_PROVIDERS) {
            revert Errors.TooManyProviders();
        }
        bool newlyAdded = _coverProviders.add(account);
        if (!newlyAdded) {
            // `newlyAdded` being false means the cover provider has been added before.
            revert Errors.AlreadyAProvider();
        }
        emit CoverProviderAdded(account);
    }

    function removeCoverProvider(address account) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.ZeroAddressProvided();

        if (balanceOf(account) != 0) {
            // We do not allow providers with assets to be removed, since allowing that would make it possible
            // for the pool owner to remove all other providers and take all yield by themselves.
            revert Errors.ProviderHasOutstandingAssets();
        }
        bool removed = _coverProviders.remove(account);
        if (!removed) {
            // `removed` being false means either the account has never been a cover provider,
            // or it has been removed before.
            revert Errors.CoverProviderRequired();
        }
        emit CoverProviderRemoved(account);
    }

    /// @inheritdoc IFirstLossCover
    function depositCover(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert Errors.ZeroAmountProvided();
        _onlyCoverProvider(msg.sender);

        // Note: we have to mint the shares first by calling _deposit() before transferring the assets.
        // Transferring assets first would increase the total cover assets without increasing the supply, resulting in
        // the depositor receiving fewer shares than they should.
        shares = _deposit(assets, msg.sender);
        underlyingToken.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @inheritdoc IFirstLossCover
    function depositCoverFor(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.ZeroAmountProvided();
        if (receiver == address(0)) revert Errors.ZeroAddressProvided();
        _onlyPoolFeeManager(msg.sender);

        // Note: we have to mint the shares first by calling _deposit() before transferring the assets.
        // Transferring assets first would increase the total cover assets without increasing the supply, resulting in
        // the depositor receiving fewer shares than they should.
        shares = _deposit(assets, receiver);
        underlyingToken.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @inheritdoc IFirstLossCover
    function addCoverAssets(uint256 assets) external {
        poolConfig.onlyPool(msg.sender);
        poolSafe.withdraw(address(this), assets);

        emit AssetsAdded(assets);
    }

    /// @inheritdoc IFirstLossCover
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets) {
        if (shares == 0) revert Errors.ZeroAmountProvided();
        if (receiver == address(0)) revert Errors.ZeroAddressProvided();

        uint256 minLiquidity = getMinLiquidity();
        uint256 currTotalAssets = totalAssets();

        bool ready = pool.readyForFirstLossCoverWithdrawal();
        // If ready, all assets can be withdrawn. Otherwise, only the excessive assets over the minimum
        // liquidity requirement can be withdrawn.
        if (!ready && currTotalAssets <= minLiquidity)
            revert Errors.PoolIsNotReadyForFirstLossCoverWithdrawal();

        if (shares > balanceOf(msg.sender)) revert Errors.InsufficientSharesForRequest();
        assets = convertToAssets(shares);
        // Revert if the pool is not ready and the assets to be withdrawn is more than the available value.
        if (!ready && assets > currTotalAssets - minLiquidity)
            revert Errors.InsufficientAmountForRequest();

        ERC20Upgradeable._burn(msg.sender, shares);
        underlyingToken.safeTransfer(receiver, assets);
        emit CoverRedeemed(msg.sender, receiver, shares, assets);
    }

    /// @inheritdoc IFirstLossCover
    function coverLoss(uint256 loss) external returns (uint256 remainingLoss) {
        poolConfig.onlyPool(msg.sender);

        uint256 coveredAmount;
        (remainingLoss, coveredAmount) = _calcLossCover(loss);

        if (coveredAmount > 0) {
            poolSafe.deposit(address(this), coveredAmount);

            uint256 newCoveredLoss = coveredLoss;
            newCoveredLoss += coveredAmount;
            coveredLoss = newCoveredLoss;

            emit LossCovered(coveredAmount, remainingLoss, newCoveredLoss);
        }
    }

    /// @inheritdoc IFirstLossCover
    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        poolConfig.onlyPool(msg.sender);

        uint256 recoveredAmount;
        (remainingRecovery, recoveredAmount) = _calcLossRecovery(coveredLoss, recovery);

        if (recoveredAmount > 0) {
            uint256 currCoveredLoss = coveredLoss;
            currCoveredLoss -= recoveredAmount;
            coveredLoss = currCoveredLoss;

            poolSafe.withdraw(address(this), recoveredAmount);

            emit LossRecovered(recoveredAmount, currCoveredLoss);
        }
    }

    /**
     * @notice Pays out yield above the max liquidity to providers.
     * @notice Yield payout is expected to be handled by a cron-like mechanism like autotask.
     */
    function payoutYield() external {
        poolConfig.onlyProtocolAndPoolOn();

        uint256 maxLiquidity = getMaxLiquidity();
        uint256 assets = totalAssets();
        if (assets <= maxLiquidity) return;

        uint256 yield = assets - maxLiquidity;
        uint256 totalShares = totalSupply();
        address[] memory providers = _coverProviders.values();
        uint256 remainingShares = totalShares;
        for (uint256 i = 0; i < providers.length; i++) {
            address provider = providers[i];
            uint256 shares = balanceOf(provider);
            if (shares == 0) continue;

            uint256 payout = (yield * shares) / totalShares;
            remainingShares -= shares;
            underlyingToken.safeTransfer(provider, payout);
            emit YieldPaidOut(provider, payout);
        }

        // We expect all yield to be paid out in one go. It's technically impossible for remainingShares
        // to be non-zero, but adding an assertion here just to be safe.
        assert(remainingShares == 0);
    }

    function isSufficient() external view returns (bool sufficient) {
        return totalAssets() >= getMinLiquidity();
    }

    function getCoverProviders() external view returns (address[] memory providers) {
        providers = _coverProviders.values();
    }

    function totalAssetsOf(address account) external view returns (uint256 assets) {
        return convertToAssets(ERC20Upgradeable.balanceOf(account));
    }

    /**
     * @notice Disallows first loss cover tokens to be transferred.
     */
    function transfer(address, uint256) public virtual override returns (bool) {
        revert Errors.UnsupportedFunction();
    }

    /**
     * @notice Disallows first loss cover tokens to be transferred.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        revert Errors.UnsupportedFunction();
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalAssets() public view virtual returns (uint256) {
        return underlyingToken.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view virtual returns (uint256) {
        uint256 currTotalSupply = totalSupply();
        uint256 currTotalAssets = totalAssets();

        return currTotalSupply == 0 ? assets : (assets * currTotalSupply) / currTotalAssets;
    }

    function convertToAssets(uint256 shares) public view virtual returns (uint256) {
        uint256 currTotalSupply = totalSupply();
        uint256 currTotalAssets = totalAssets();

        return currTotalSupply == 0 ? shares : (shares * currTotalAssets) / currTotalSupply;
    }

    /// @inheritdoc IFirstLossCover
    function getAvailableCap() public view returns (uint256 availableCap) {
        uint256 coverTotalAssets = totalAssets();
        uint256 maxLiquidity = getMaxLiquidity();
        return maxLiquidity > coverTotalAssets ? maxLiquidity - coverTotalAssets : 0;
    }

    /// @inheritdoc IFirstLossCover
    function getMaxLiquidity() public view returns (uint256 maxLiquidity) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));
        return config.maxLiquidity;
    }

    /// @inheritdoc IFirstLossCover
    function getMinLiquidity() public view returns (uint256 minLiquidity) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));
        return config.minLiquidity;
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address oldUnderlyingToken = address(underlyingToken);
        address newUnderlyingToken = _poolConfig.underlyingToken();
        assert(newUnderlyingToken != address(0));
        underlyingToken = IERC20(newUnderlyingToken);
        _decimals = IERC20MetadataUpgradeable(newUnderlyingToken).decimals();

        address oldPoolSafe = address(poolSafe);
        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);
        _resetPoolSafeAllowance(oldPoolSafe, addr, oldUnderlyingToken, newUnderlyingToken);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);
    }

    /**
     * @notice Resets the allowance of the old pool safe to 0 and approve a new allowance for the new pool safe.
     * @dev This function is called when setting the pool safe address in `_updatePoolConfigData()`.
     */
    function _resetPoolSafeAllowance(
        address oldPoolSafe,
        address newPoolSafe,
        address oldUnderlyingToken,
        address newUnderlyingToken
    ) internal {
        if (oldPoolSafe == newPoolSafe && oldUnderlyingToken == newUnderlyingToken) {
            // No need to do anything if none of the addresses changed.
            return;
        }
        if (oldPoolSafe != address(0) && oldUnderlyingToken != address(0)) {
            // Old pool safe address and the old underlying token address may be 0 if this is
            // the first ever initialization of the contract.
            uint256 allowance = IERC20(oldUnderlyingToken).allowance(address(this), oldPoolSafe);
            IERC20(oldUnderlyingToken).safeDecreaseAllowance(oldPoolSafe, allowance);
        }
        // The caller should have checked that the new underlying token and new pool safe
        // are not zero-addresses.
        assert(newPoolSafe != address(0));
        assert(newUnderlyingToken != address(0));
        IERC20(newUnderlyingToken).safeIncreaseAllowance(newPoolSafe, type(uint256).max);
    }

    function _deposit(uint256 assets, address account) internal returns (uint256 shares) {
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        if (assets < poolSettings.minDepositAmount) {
            revert Errors.DepositAmountTooLow();
        }
        if (assets > getAvailableCap()) {
            revert Errors.FirstLossCoverLiquidityCapExceeded();
        }

        shares = convertToShares(assets);
        ERC20Upgradeable._mint(account, shares);

        emit CoverDeposited(account, assets, shares);
    }

    /**
     * @notice Calculates the amount of loss that can be covered by the fist loss cover.
     * @param loss The total amount of loss to cover.
     * @return remainingLoss The remaining amount of loss not covered.
     * @return coveredAmount The amount of loss covered.
     */
    function _calcLossCover(
        uint256 loss
    ) internal view returns (uint256 remainingLoss, uint256 coveredAmount) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));

        // The covered amount is the minimum of:
        // 1. The total loss.
        // 2. loss * coverRatePerLossInBps, i.e. how ratio to cover per occurrence of the loss.
        // 3. coverCapPerLoss, i.e. the maximum amount to cover per occurrence of the loss.
        // 4. The available amount of assets in the first loss cover.
        uint256 availableAmount = (loss * config.coverRatePerLossInBps) / HUNDRED_PERCENT_IN_BPS;
        if (availableAmount >= config.coverCapPerLoss) {
            availableAmount = config.coverCapPerLoss;
        }

        uint256 currTotalAssets = totalAssets();
        if (availableAmount >= currTotalAssets) {
            availableAmount = currTotalAssets;
        }

        coveredAmount = availableAmount >= loss ? loss : availableAmount;
        remainingLoss = loss - coveredAmount;
    }

    function _onlyCoverProvider(address account) internal view {
        if (!_coverProviders.contains(account)) {
            revert Errors.CoverProviderRequired();
        }
    }

    function _onlyPoolFeeManager(address account) internal view {
        if (account != poolConfig.poolFeeManager())
            revert Errors.AuthorizedContractCallerRequired();
    }

    function _calcLossRecovery(
        uint256 coveredLoss,
        uint256 recoveryAmount
    ) internal pure returns (uint256 remainingRecovery, uint256 recoveredAmount) {
        recoveredAmount = coveredLoss < recoveryAmount ? coveredLoss : recoveryAmount;
        remainingRecovery = recoveryAmount - recoveredAmount;
    }
}
