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
import {IProfitEscrow} from "./interfaces/IProfitEscrow.sol";
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
    using SafeERC20 for IERC20;

    event CoverProviderSet(
        address indexed account,
        uint256 poolCapCoverageInBps,
        uint256 poolValueCoverageInBps
    );

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

        addr = _poolConfig.getFirstLossCoverProfitEscrow(address(this));
        //* todo the following comment is strange. We should not allow zero address.
        // A careless change may get us into a situation of losing funds into
        // zero address. We should find a different way to handle this.

        // It is possible to be null for borrower first loss cover
        // if (addr == address(0)) revert Errors.zeroAddressProvided();
        profitEscrow = IProfitEscrow(addr);
    }

    function setCoverProvider(address account, LossCoverProviderConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.zeroAddressProvided();
        providerConfigs[account] = config;

        emit CoverProviderSet(account, config.poolCapCoverageInBps, config.poolValueCoverageInBps);
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
        poolConfig.onlyPoolFeeManager(msg.sender);

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

        uint96[2] memory tranchesAssets = pool.refreshPool();
        uint256 cap = getCapacity(tranchesAssets[SENIOR_TRANCHE] + tranchesAssets[JUNIOR_TRANCHE]);
        uint256 currTotalAssets = totalAssets();

        //: todo pool.readyForFirstLossCoverWithdrawal() is a tricky design.
        bool ready = pool.readyForFirstLossCoverWithdrawal();
        // If ready, all assets can be withdrawn. Otherwise, only the excessive assets over the cap can be withdrawn.
        if (currTotalAssets <= cap && !ready)
            revert Errors.poolIsNotReadyForFirstLossCoverWithdrawal();

        if (shares > balanceOf(msg.sender)) revert Errors.insufficientSharesForRequest();
        assets = convertToAssets(shares);
        // Revert if the pool is not ready and the assets to be withdrawn is more than the available value.
        if (!ready && assets > currTotalAssets - cap) revert Errors.todo();

        ERC20Upgradeable._burn(msg.sender, shares);
        if (address(profitEscrow) != address(0)) profitEscrow.withdraw(msg.sender, shares);
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
    function recoverLoss(uint256 recovery) external {
        poolConfig.onlyPool(msg.sender);

        poolSafe.withdraw(address(this), recovery);

        uint256 currCoveredLoss = coveredLoss;
        currCoveredLoss -= recovery;
        coveredLoss = currCoveredLoss;

        emit LossRecovered(recovery, currCoveredLoss);
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

    function calcLossCover(uint256 loss) public view returns (uint256 remainingLoss) {
        (remainingLoss, ) = _calcLossCover(loss);
    }

    function calcLossRecover(
        uint256 recovery
    ) public view returns (uint256 remainingRecovery, uint256 recoveredAmount) {
        (remainingRecovery, recoveredAmount) = _calcLossRecover(coveredLoss, recovery);
    }

    function isSufficient(address account) external view returns (bool) {
        _onlyCoverProvider(account);
        uint256 balance = convertToAssets(balanceOf(account));
        uint256 min = _getMinCoverAmount(account);
        console.log("balance: %s, min: %s", balance, min);
        return balance >= min;
    }

    function getCapacity(uint256 poolAssets) public view returns (uint256) {
        FirstLossCoverConfig memory lossCoverConfig = poolConfig.getFirstLossCoverConfig(
            address(this)
        );
        uint256 capFromPoolAssets = (poolAssets * lossCoverConfig.maxPercentOfPoolValueInBps) /
            HUNDRED_PERCENT_IN_BPS;
        return
            lossCoverConfig.liquidityCap > capFromPoolAssets
                ? lossCoverConfig.liquidityCap
                : capFromPoolAssets;
    }

    function getCoverProviderConfig(
        address account
    ) external view returns (LossCoverProviderConfig memory) {
        return providerConfigs[account];
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
        shares = convertToShares(assets);
        ERC20Upgradeable._mint(account, shares);

        if (address(profitEscrow) != address(0)) profitEscrow.deposit(account, shares);

        emit CoverDeposited(account, assets, shares);
    }

    function _calcLossCover(
        uint256 loss
    ) internal view returns (uint256 remainingLoss, uint256 coveredAmount) {
        FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(address(this));

        uint256 availableAmount = (loss * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        if (availableAmount >= config.coverCap) {
            availableAmount = config.coverCap;
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

    function _getMinCoverAmount(address account) internal view returns (uint256 minCoverAmount) {
        LossCoverProviderConfig memory config = providerConfigs[account];
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 poolCap = lpConfig.liquidityCap;
        uint256 minFromPoolCap = (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * config.poolValueCoverageInBps) /
            HUNDRED_PERCENT_IN_BPS;
        return minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;
    }

    function _onlyCoverProvider(address account) internal view {
        LossCoverProviderConfig memory config = providerConfigs[account];
        if (config.poolCapCoverageInBps == 0 && config.poolValueCoverageInBps == 0)
            revert Errors.notCoverProvider();
    }
}
