// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {FirstLossCoverStorage, IERC20} from "./FirstLossCoverStorage.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import "./SharedDefs.sol";
import {Errors} from "./Errors.sol";

interface ITrancheVaultLike {
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

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

    event CoverDeposited(
        address indexed by,
        address indexed receiver,
        uint256 assets,
        uint256 shares
    );
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
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();
    }

    function setPayoutConfig(LossCoverPayoutConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        lossCoverPayoutConfig = config;

        emit PayoutConfigSet(config.coverRateInBps, config.coverCap, config.liquidityCap);
    }

    function setOperator(address account, LossCoverConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.zeroAddressProvided();
        operatorConfigs[account] = config;

        emit OperatorSet(account, config.poolCapCoverageInBps, config.poolValueCoverageInBps);
    }

    function depositCover(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        _onlyOperator(msg.sender);

        poolVault.deposit(msg.sender, assets);

        return _deposit(assets, receiver);
    }

    function depositTrancheVaultToken(
        address trancheVaultAddress,
        uint256 tokenAmount,
        address receiver
    ) external returns (uint256 shares) {
        if (tokenAmount == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        poolConfig.onlyTrancheVault(trancheVaultAddress);

        ITrancheVaultLike trancheVault = ITrancheVaultLike(trancheVaultAddress);
        uint256 assets = trancheVault.convertToAssets(tokenAmount);

        return _deposit(assets, receiver);
    }

    // Deposit fees of protocol owner, pool owner and EA again by pool contract
    function depositByPool(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        poolConfig.onlyPool(msg.sender);

        return _deposit(assets, receiver);
    }

    function distributeProfit(uint256 profit) external {
        poolConfig.onlyPool(msg.sender);

        uint256 tempTotalAssets = _totalAssets;
        tempTotalAssets += profit;
        _totalAssets = tempTotalAssets;

        // TODO put profit into escrow contract if liquidity cap is reached

        emit ProfitDistributed(profit, tempTotalAssets);
    }

    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        if (!pool.readyToWithdrawFirstLossCover())
            revert Errors.poolIsNotReadyToWithdrawFirstLossCover();

        assets = convertToAssets(shares);
        ERC20Upgradeable._burn(msg.sender, shares);
        _totalAssets -= assets;

        poolVault.withdraw(receiver, assets);

        emit CoverRedeemed(msg.sender, receiver, shares, assets);
    }

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        poolConfig.onlyPool(msg.sender);

        uint256 coveredAmount;
        (remainingLoss, coveredAmount) = _calcLossCover(poolAssets, loss);
        if (coveredAmount > 0) {
            uint256 tempTotalAssets = _totalAssets;
            tempTotalAssets -= coveredAmount;
            _totalAssets = tempTotalAssets;
            uint256 tempCoveredLoss = coveredLoss;
            tempCoveredLoss += coveredAmount;
            coveredLoss = tempCoveredLoss;
            emit LossCovered(coveredAmount, remainingLoss, tempTotalAssets, tempCoveredLoss);
        }
    }

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        poolConfig.onlyPool(msg.sender);

        uint256 tempCoveredLoss = coveredLoss;
        uint256 recoveredAmount;
        (remainingRecovery, recoveredAmount) = _calcLossRecover(tempCoveredLoss, recovery);
        // There may be multiple loss covers, the remainingRecovery may be positive.
        if (recoveredAmount > 0) {
            uint256 tempTotalAssets = _totalAssets;
            tempTotalAssets += recoveredAmount;
            _totalAssets = tempTotalAssets;
            tempCoveredLoss -= recoveredAmount;
            coveredLoss = tempCoveredLoss;
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
        return _totalAssets;
    }

    function convertToShares(uint256 assets) public view virtual returns (uint256) {
        uint256 totalSupply = totalSupply();
        uint256 tempTotalAssets = _totalAssets;

        return totalSupply == 0 ? assets : (assets * totalSupply) / tempTotalAssets;
    }

    function convertToAssets(uint256 shares) public view virtual returns (uint256) {
        uint256 totalSupply = totalSupply();
        uint256 tempTotalAssets = _totalAssets;

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

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        shares = convertToShares(assets);
        ERC20Upgradeable._mint(receiver, shares);
        _totalAssets += assets;

        emit CoverDeposited(msg.sender, receiver, assets, shares);
    }

    function _calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) internal view returns (uint256 remainingLoss, uint256 coveredAmount) {
        LossCoverPayoutConfig memory config = lossCoverPayoutConfig;
        uint256 availableAmount = (poolAssets * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        if (availableAmount >= config.coverCap) {
            availableAmount = config.coverCap;
        }

        uint256 tempTotalAssets = _totalAssets;
        if (availableAmount >= tempTotalAssets) {
            availableAmount = tempTotalAssets;
        }

        coveredAmount = availableAmount >= loss ? loss : availableAmount;
        remainingLoss = loss - coveredAmount;
    }

    function _calcLossRecover(
        uint256 coveredLoss,
        uint256 recovery
    ) public pure returns (uint256 remainingRecovery, uint256 recoveredAmount) {
        recoveredAmount = coveredLoss < recovery ? coveredLoss : recovery;
        remainingRecovery = recovery - recoveredAmount;
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
