// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {FirstLossCoverStorage, IERC20} from "./FirstLossCoverStorage.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IProfitEscrow} from "./interfaces/IProfitEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

import "hardhat/console.sol";

interface ITrancheVaultLike {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

/**
 * @title FirstLossCover
 */
contract FirstLossCover is
    ERC20Upgradeable,
    PoolConfigCache,
    FirstLossCoverStorage,
    IFirstLossCover
{
    event PayoutConfigSet(uint256 coverRateInBps, uint256 coverCap, uint256 liquidityCap);
    event OperatorSet(
        address indexed account,
        uint256 poolCapCoverageInBps,
        uint256 poolValueCoverageInBps
    );

    event LossCovered(
        uint256 covered,
        uint256 remaining,
        uint256 totalAssets,
        uint256 coveredLoss
    );
    event LossRecovered(
        uint256 recovered,
        uint256 remaining,
        uint256 totalAssets,
        uint256 coveredLoss
    );

    event CoverDeposited(address indexed account, uint256 assets, uint256 shares);
    event CoverRedeemed(
        address indexed by,
        address indexed receiver,
        uint256 shares,
        uint256 assets
    );
    event ProfitDistributed(uint256 profit, uint256 totalAssets);

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
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = _poolConfig.getFirstLossCoverProfitEscrow(address(this));
        //* todo the following comment is strange. We should not allow zero address.
        // A careless change may get us into a situation of losing funds into
        // zero address. We should find a different way to handle this.

        // It is possible to be null for borrower first loss cover
        // if (addr == address(0)) revert Errors.zeroAddressProvided();
        profitEscrow = IProfitEscrow(addr);
    }

    //* todo passing the parameter inside the struct instead of the struct itself.
    function setPayoutConfig(LossCoverPayoutConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        lossCoverPayoutConfig = config;

        emit PayoutConfigSet(config.coverRateInBps, config.coverCap, config.liquidityCap);
    }

    //* todo do not understand the purpose of operator for a pool cover. It seems you
    // want to make this a permissioned, and the permission is different from the pool
    // permission. Feels like overkill
    function setOperator(address account, LossCoverConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.zeroAddressProvided();
        operatorConfigs[account] = config;

        emit OperatorSet(account, config.poolCapCoverageInBps, config.poolValueCoverageInBps);
    }

    function depositCover(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        _onlyOperator(msg.sender);

        //* todo I prefer we store the cover money outsdie the pool.
        poolSafe.deposit(msg.sender, assets);

        return _deposit(assets, msg.sender);
    }

    /**
     * @notice Adds to the cover using assets from other tranches. This is convenient for LPs who
     * hold positions as both first loss covers and participants in the junior/senior tranche, so that
     * they don't have to withdraw their assets from the tranches first before adding to the first loss cover.
     */
    function depositCoverWithTrancheVaultTokens(
        address trancheVaultAddress,
        uint256 tokenAmount
    ) external returns (uint256 shares) {
        if (tokenAmount == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyTrancheVault(trancheVaultAddress);
        _onlyOperator(msg.sender);

        ITrancheVaultLike trancheVault = ITrancheVaultLike(trancheVaultAddress);
        uint256 assets = trancheVault.convertToAssets(tokenAmount);

        // TODO withdraw from tranche vault

        return _deposit(assets, msg.sender);
    }

    /**
     * @notice Adds to the cover using fees of protocol owner, pool owner and/or EA.
     */
    //* todo I do not think this belongs to first loss cover. This is the logic on how to
    // grow coverage. Including it here makes this contract convoluted.
    // Let us first not to consider it. We can add the capability
    // from the pool side. We can choose to implement a withdraw constraint for the admins
    // that they cannot withdraw until there is sufficient first loss cover.
    function depositCoverWithAffiliateFees(
        uint256 assets,
        address receiver
    ) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        poolConfig.onlyPoolFeeManager(msg.sender);

        return _deposit(assets, receiver);
    }

    /**
     * @notice Distributes profit to the cover. If there is still room in the cover, this profit
     * is applied towards increasing coverage. The remainder of the profit is distributed to the
     * first loss cover providers.
     * @param profit the profit to be distributed
     * @dev Only pool can call this function
     */
    function distributeProfit(uint256 profit) external {
        poolConfig.onlyPool(msg.sender);

        uint256 availableCapacity = availableCoverCapacity();
        uint256 profitToInvestInCover = profit > availableCapacity ? availableCapacity : profit;

        // Invests into the cover until it reaches capacity
        if (profitToInvestInCover > 0) {
            uint256 tempCoverAssets = _coverAssets;
            tempCoverAssets += profitToInvestInCover;
            _coverAssets = tempCoverAssets;
            emit ProfitDistributed(profitToInvestInCover, tempCoverAssets);
        }

        // Distributes the remainder profit to the cover providers
        uint256 remainingProfit = profit - profitToInvestInCover;
        if (remainingProfit > 0) {
            profitEscrow.addProfit(remainingProfit);
        }
    }

    /**
     * @notice Cover provider redeems from the pool
     * @param shares the number of shares to be redeemed
     * @param receiver the address to receive the redemption assets
     * @dev Anyone can call this function, but they will have to burn their own shares
     */
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets) {
        if (shares == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        //: todo pool.readyForFirstLossCoverWithdrawal() is a tricky design.
        if (!pool.readyForFirstLossCoverWithdrawal())
            revert Errors.poolIsNotReadyForFirstLossCoverWithdrawal();

        //* todo should we check msg.sender has this many shared? 
        assets = convertToAssets(shares);
        
        ERC20Upgradeable._burn(msg.sender, shares);
        _coverAssets -= assets;

        if (address(profitEscrow) != address(0)) profitEscrow.withdraw(msg.sender, shares);

        poolSafe.withdraw(receiver, assets);

        emit CoverRedeemed(msg.sender, receiver, shares, assets);
    }

    /**
     * @notice Applies loss against the first loss cover
     * @param poolAssets the total asset in the pool
     * @param loss the loss amount to be covered by the loss cover or reported as default
     * @return remainingLoss the remaining loss after applying this cover
     */
    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        poolConfig.onlyPool(msg.sender);

        uint256 coveredAmount;
        (remainingLoss, coveredAmount) = _calcLossCover(poolAssets, loss);

        if (coveredAmount > 0) {
            uint256 newCoverAssets = _coverAssets;
            newCoverAssets -= coveredAmount;
            _coverAssets = newCoverAssets;

            uint256 newCoveredLoss = coveredLoss;
            newCoveredLoss += coveredAmount;
            coveredLoss = newCoveredLoss;

            emit LossCovered(coveredAmount, remainingLoss, newCoverAssets, newCoveredLoss);
        }
    }

    /**
     * @notice Applies recovered amount to this first loss cover
     * @param recovery the recovery amount available for distribution to this cover
     * and other covers that are more junior than this one.
     * @dev Only pool contract tied with the cover can call this function.
     */
    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        poolConfig.onlyPool(msg.sender);

        uint256 tempCoveredLoss = coveredLoss;
        uint256 recoveredAmount;
        (remainingRecovery, recoveredAmount) = _calcLossRecover(tempCoveredLoss, recovery);
        // There may be multiple loss covers, the remainingRecovery may be positive.
        if (recoveredAmount > 0) {
            uint256 tempTotalAssets = _coverAssets;
            tempTotalAssets += recoveredAmount;
            _coverAssets = tempTotalAssets;
            tempCoveredLoss -= recoveredAmount;
            coveredLoss = tempCoveredLoss;

            //* todo If there are multiple first loss covers, do we need something to identify
            // the cover that received the recovery in the event?
            emit LossRecovered(
                recoveredAmount,
                remainingRecovery,
                tempTotalAssets,
                tempCoveredLoss
            );
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalAssets() public view virtual returns (uint256) {
        return _coverAssets;
    }

    function availableCoverCapacity() public view returns (uint256 coverCapacity) {
        LossCoverPayoutConfig memory config = lossCoverPayoutConfig;
        uint256 tempCoverAssets = _coverAssets;
        return config.liquidityCap > tempCoverAssets ? config.liquidityCap - tempCoverAssets : 0;
    }

    function convertToShares(uint256 assets) public view virtual returns (uint256) {
        uint256 totalSupply = totalSupply();
        uint256 tempTotalAssets = _coverAssets;

        return totalSupply == 0 ? assets : (assets * totalSupply) / tempTotalAssets;
    }

    function convertToAssets(uint256 shares) public view virtual returns (uint256) {
        uint256 totalSupply = totalSupply();
        uint256 tempTotalAssets = _coverAssets;

        return totalSupply == 0 ? shares : (shares * tempTotalAssets) / totalSupply;
    }

    function calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) public view returns (uint256 remainingLoss) {
        (remainingLoss, ) = _calcLossCover(poolAssets, loss);
    }

    function calcLossRecover(uint256 recovery) public view returns (uint256 remainingRecovery) {
        (remainingRecovery, ) = _calcLossRecover(coveredLoss, recovery);
    }

    function isSufficient(address account) external view returns (bool) {
        _onlyOperator(account);
        uint256 operatorBalance = convertToAssets(balanceOf(account));
        uint256 min = _getMinCoverAmount(account);
        return operatorBalance >= min;
    }

    function getPayoutConfig() external view returns (LossCoverPayoutConfig memory) {
        return lossCoverPayoutConfig;
    }

    function getMaxCoverConfig() external view returns (LossCoverConfig memory) {
        return maxCoverConfig;
    }

    function getOperatorConfig(address account) external view returns (LossCoverConfig memory) {
        return operatorConfigs[account];
    }

    function _deposit(uint256 assets, address account) internal returns (uint256 shares) {
        shares = convertToShares(assets);
        ERC20Upgradeable._mint(account, shares);
        _coverAssets += assets;

        if (address(profitEscrow) != address(0)) profitEscrow.deposit(account, shares);

        emit CoverDeposited(account, assets, shares);
    }

    function _calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) internal view returns (uint256 remainingLoss, uint256 coveredAmount) {
        LossCoverPayoutConfig memory config = lossCoverPayoutConfig;

        //* todo BUG. coverRateInBps should be applied against loss, not the pool asset value
        uint256 availableAmount = (poolAssets * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        if (availableAmount >= config.coverCap) {
            availableAmount = config.coverCap;
        }

        uint256 tempTotalAssets = _coverAssets;
        if (availableAmount >= tempTotalAssets) {
            availableAmount = tempTotalAssets;
        }

        coveredAmount = availableAmount >= loss ? loss : availableAmount;
        remainingLoss = loss - coveredAmount;
    }

    function _calcLossRecover(
        uint256 coveredLoss,
        uint256 recoveryAmount
    ) public pure returns (uint256 remainingRecovery, uint256 recoveredAmount) {
        recoveredAmount = coveredLoss < recoveryAmount ? coveredLoss : recoveryAmount;
        remainingRecovery = recoveryAmount - recoveredAmount;
    }

    function _getMinCoverAmount(address account) internal view returns (uint256 minCoverAmount) {
        LossCoverConfig memory config = operatorConfigs[account];
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 poolCap = lpConfig.liquidityCap;
        uint256 minFromPoolCap = (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * config.poolValueCoverageInBps) /
            HUNDRED_PERCENT_IN_BPS;
        return minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;
    }

    function _onlyOperator(address account) internal view {
        LossCoverConfig memory config = operatorConfigs[account];
        if (config.poolCapCoverageInBps == 0 && config.poolValueCoverageInBps == 0)
            revert Errors.notOperator();
    }
}
