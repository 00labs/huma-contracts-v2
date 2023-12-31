// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {FirstLossCoverStorage} from "./FirstLossCoverStorage.sol";
import {PoolConfig, LPConfig, FirstLossCoverConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {HUNDRED_PERCENT_IN_BPS, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "hardhat/console.sol";

/**
 * @title FirstLossCover
 */
contract FirstLossCover is
    ERC20Upgradeable,
    PoolConfigCache,
    FirstLossCoverStorage,
    IFirstLossCover
{
    uint256 private constant MAX_ALLOWED_NUM_PROVIDERS = 100;

    using SafeERC20 for IERC20;

    event CoverProviderAdded(address indexed account);

    event LossCovered(uint256 covered, uint256 remaining, uint256 coveredLoss);
    event LossRecovered(uint256 recovered, uint256 coveredLoss);

    event CoverDeposited(address indexed account, uint256 assets, uint256 shares);
    event CoverRedeemed(
        address indexed by,
        address indexed receiver,
        uint256 shares,
        uint256 assets
    );
    event AssetsAdded(uint256 assets);

    event YieldPaidout(address indexed account, uint256 yields);

    constructor() {
        // _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig
    ) external initializer {
        __ERC20_init(name, symbol);
        _initialize(_poolConfig);
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address oldUnderlyingToken = address(underlyingToken);
        address newUnderlyingToken = _poolConfig.underlyingToken();
        if (newUnderlyingToken == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(newUnderlyingToken);
        _decimals = IERC20MetadataUpgradeable(newUnderlyingToken).decimals();

        address oldPoolSafe = address(poolSafe);
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);
        _resetPoolSafeAllowance(oldPoolSafe, addr, oldUnderlyingToken, newUnderlyingToken);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);
    }

    function getCoverProviders() external view returns (address[] memory providers) {
        return _coverProviders;
    }

    function addCoverProvider(address account) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.zeroAddressProvided();
        _coverProviders.push(account);
        emit CoverProviderAdded(account);
    }

    /// @inheritdoc IFirstLossCover
    function depositCover(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        _onlyCoverProvider(msg.sender);

        // Note: we have to mint the shares first by calling _deposit() before transferring the assets.
        // Transferring assets first would increase the total cover assets without increasing the supply, resulting in
        // the depositor receiving fewer shares than they should.
        shares = _deposit(assets, msg.sender);
        underlyingToken.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @inheritdoc IFirstLossCover
    function depositCoverFor(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
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
        if (shares == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();

        uint256 minLiquidity = getMinLiquidity();
        uint256 currTotalAssets = totalAssets();

        //: todo pool.readyForFirstLossCoverWithdrawal() is a tricky design.
        bool ready = pool.readyForFirstLossCoverWithdrawal();
        // If ready, all assets can be withdrawn. Otherwise, only the excessive assets over the minimum
        // liquidity requirement can be withdrawn.
        if (!ready && currTotalAssets <= minLiquidity)
            revert Errors.poolIsNotReadyForFirstLossCoverWithdrawal();

        if (shares > balanceOf(msg.sender)) revert Errors.insufficientSharesForRequest();
        assets = convertToAssets(shares);
        // Revert if the pool is not ready and the assets to be withdrawn is more than the available value.
        if (!ready && assets > currTotalAssets - minLiquidity)
            revert Errors.insufficientAmountForRequest();

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
        (remainingRecovery, recoveredAmount) = _calcLossRecover(coveredLoss, recovery);

        if (recoveredAmount > 0) {
            poolSafe.withdraw(address(this), recovery);

            uint256 currCoveredLoss = coveredLoss;
            currCoveredLoss -= recovery;
            coveredLoss = currCoveredLoss;

            emit LossRecovered(recovery, currCoveredLoss);
        }
    }

    /**
     * @notice Disables transfer function currently
     */
    function transfer(address, uint256) public virtual override returns (bool) {
        revert Errors.unsupportedFunction();
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

    function totalAssetsOf(address account) external view returns (uint256 assets) {
        return convertToAssets(ERC20Upgradeable.balanceOf(account));
    }

    /**
     * @notice Pay out yield above the cap to providers. Expects to be called by a cron-like mechanism like autotask.
     * @param providers All first loss cover providers
     */
    function payoutYield(address[] calldata providers) external {
        uint256 maxLiquidity = getMaxLiquidity();
        uint256 assets = totalAssets();
        if (assets <= maxLiquidity) return;

        uint256 yield = assets - maxLiquidity;
        uint256 totalShares = totalSupply();
        uint256 len = providers.length;
        uint256 remainingShares = totalShares;
        for (uint256 i; i < len && i < MAX_ALLOWED_NUM_PROVIDERS; i++) {
            address provider = providers[i];
            uint256 shares = balanceOf(provider);
            if (shares == 0) continue;

            uint256 payout = (yield * shares) / totalShares;
            underlyingToken.safeTransfer(provider, payout);
            remainingShares -= shares;
            emit YieldPaidout(provider, payout);
        }

        // Reverts this transaction if only partial providers are paid out.
        if (remainingShares > 0) revert Errors.notAllProvidersPaidOut();
    }

    function isSufficient() external view returns (bool sufficient) {
        return totalAssets() >= getMinLiquidity();
    }

    /// @inheritdoc IFirstLossCover
    function getAvailableCap() public view returns (uint256 availableCap) {
        uint256 coverTotalAssets = totalAssets();
        uint256 maxLiquidity = getMaxLiquidity();
        return maxLiquidity > coverTotalAssets ? maxLiquidity - coverTotalAssets : 0;
    }

    function getMaxLiquidity() public view returns (uint256 maxLiquidity) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));
        return config.maxLiquidity;
    }

    function getMinLiquidity() public view returns (uint256 minLiquidity) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));
        return config.minLiquidity;
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
        if (assets > getAvailableCap()) {
            revert Errors.firstLossCoverLiquidityCapExceeded();
        }

        shares = convertToShares(assets);
        ERC20Upgradeable._mint(account, shares);

        emit CoverDeposited(account, assets, shares);
    }

    function _calcLossCover(
        uint256 loss
    ) internal view returns (uint256 remainingLoss, uint256 coveredAmount) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));

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

    function _calcLossRecover(
        uint256 coveredLoss,
        uint256 recoveryAmount
    ) internal pure returns (uint256 remainingRecovery, uint256 recoveredAmount) {
        recoveredAmount = coveredLoss < recoveryAmount ? coveredLoss : recoveryAmount;
        remainingRecovery = recoveryAmount - recoveredAmount;
    }

    function _onlyCoverProvider(address account) internal view {
        address[] memory providers = _coverProviders;
        for (uint256 i; i < providers.length; ++i) {
            if (account == providers[i]) return;
        }
        revert Errors.notCoverProvider();
    }

    function _onlyPoolFeeManager(address account) internal view {
        if (account != poolConfig.poolFeeManager()) revert Errors.notAuthorizedCaller();
    }
}
