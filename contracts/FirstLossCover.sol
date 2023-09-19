// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import "./SharedDefs.sol";
import {Errors} from "./Errors.sol";

import "hardhat/console.sol";

// TODO design first loss cover fee

contract FirstLossCover is PoolConfigCache, IFirstLossCover {
    struct LossCoverConfig {
        // Percentage of the pool cap required to be covered by first loss cover
        uint16 poolCapCoverageInBps;
        // Percentage of the pool value required to be covered by first loss cover
        uint16 poolValueCoverageInBps;
    }

    struct LossCoverPayoutConfig {
        // The percentage of a default to be paid by the first loss cover
        uint16 coverRateInBps;
        // The max amount that first loss cover can spend on one default
        uint96 coverCap;
    }

    IPool public pool;
    IPoolVault public poolVault;
    IERC20 public asset;

    /// The cumulative amount of loss covered.
    uint256 public coveredLoss;

    mapping(address => LossCoverConfig) public operatorConfigs;
    mapping(address => uint256) public amounts;
    LossCoverPayoutConfig public lossCoverPayoutConfig;

    event OperatorSet(
        address indexed account,
        uint256 poolCapCoverageInBps,
        uint256 poolValueCoverageInBps
    );
    event PayoutConfigSet(uint256 coverRateInBps, uint256 coverCap);

    event CoverAdded(address indexed account, uint256 amount);
    event CoverRemoved(address indexed account, uint256 amount, address receiver);

    event LossCovered(uint256 covered, uint256 remaining);
    event LossRecovered(uint256 recovered, uint256 remaining);

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        asset = IERC20(addr);
    }

    function setPayoutConfig(LossCoverPayoutConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        lossCoverPayoutConfig = config;

        emit PayoutConfigSet(config.coverRateInBps, config.coverCap);
    }

    function setOperator(address account, LossCoverConfig memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        if (account == address(0)) revert Errors.zeroAddressProvided();
        operatorConfigs[account] = config;

        emit OperatorSet(account, config.poolCapCoverageInBps, config.poolValueCoverageInBps);
    }

    function addCover(uint256 amount) external {
        _onlyOperator(msg.sender);
        if (amount == 0) revert Errors.zeroAmountProvided();

        asset.transferFrom(msg.sender, address(this), amount);
        uint256 operatorAmount = amounts[msg.sender];
        operatorAmount += amount;
        amounts[msg.sender] = operatorAmount;

        emit CoverAdded(msg.sender, amount);
    }

    function removeCover(uint256 amount, address receiver) external {
        if (amount == 0) revert Errors.zeroAmountProvided();
        uint256 operatorBalance = amounts[msg.sender];
        if (operatorBalance < amount) revert Errors.withdrawnAmountHigherThanBalance();
        uint256 balance = asset.balanceOf(address(this));
        if (balance < amount) revert Errors.insufficientTotalBalance();

        uint256 minCover = _getMinCoverAmount(msg.sender);
        if (operatorBalance - amount < minCover) revert Errors.lessThanRequiredCover();

        operatorBalance -= amount;
        asset.transfer(receiver, amount);

        emit CoverRemoved(msg.sender, amount, receiver);
    }

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        poolConfig.onlyPool(msg.sender);

        LossCoverPayoutConfig memory config = lossCoverPayoutConfig;
        uint256 coveredAmount = (poolAssets * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        if (coveredAmount >= config.coverCap) {
            coveredAmount = config.coverCap;
        }

        uint256 assets = asset.balanceOf(address(this));
        if (coveredAmount >= assets) {
            coveredAmount = assets;
        }
        remainingLoss = loss - coveredAmount;
        if (coveredAmount > 0) {
            coveredLoss += coveredAmount;
            poolVault.deposit(address(this), coveredAmount);
        }

        emit LossCovered(coveredAmount, remainingLoss);
    }

    function calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) external view returns (uint256 remainingLoss) {}

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        poolConfig.onlyPool(msg.sender);

        uint256 tempCoveredLoss = coveredLoss;
        uint256 recovered = tempCoveredLoss < recovery ? tempCoveredLoss : recovery;
        // There may be multiple loss covers, the remainingRecovery may be positive.
        remainingRecovery = recovery - recovered;
        if (recovered > 0) {
            coveredLoss = tempCoveredLoss - recovered;
            poolVault.withdraw(address(this), recovered);
        }

        emit LossRecovered(recovered, remainingRecovery);
    }

    function calcLossRecover(uint256 recovery) external view returns (uint256 remainingRecovery) {}

    function isSufficient(address account) external view returns (bool) {
        _onlyOperator(account);

        uint256 operatorBalance = amounts[account];
        uint256 min = _getMinCoverAmount(account);
        return operatorBalance >= min;
    }

    function removableAmount(address account) external view returns (uint256 amount) {
        uint256 operatorBalance = amounts[msg.sender];
        uint256 min = _getMinCoverAmount(account);

        amount = operatorBalance > min ? operatorBalance - min : 0;
    }

    function getPayoutConfig() external view returns (uint256 coverRateInBps, uint256 coverCap) {
        LossCoverPayoutConfig memory config = lossCoverPayoutConfig;
        coverRateInBps = config.coverRateInBps;
        coverCap = config.coverCap;
    }

    function _onlyOperator(address account) internal view {
        LossCoverConfig memory config = operatorConfigs[account];
        if (config.poolCapCoverageInBps == 0 && config.poolValueCoverageInBps == 0)
            revert Errors.notOperator();
    }

    function _getMinCoverAmount(address account) internal view returns (uint256 amount) {
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        LossCoverConfig memory config = operatorConfigs[account];
        uint256 poolCap = lpConfig.liquidityCap;
        uint256 minFromPoolCap = (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * config.poolValueCoverageInBps) /
            HUNDRED_PERCENT_IN_BPS;
        amount = minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;
    }
}
