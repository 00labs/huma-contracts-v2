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
    struct LossCoverFund {
        // percentage of the pool cap required to be covered by first loss cover
        uint16 poolCapCoverageInBps;
        // percentage of the pool value required to be covered by first loss cover
        uint16 poolValueCoverageInBps;
    }

    struct LossCoverPayout {
        // The percentage of a default to be paid by the first loss cover
        uint16 coverRateInBps;
        // The max amount that first loss cover can spend on one default
        uint96 coverCap;
    }

    IPool public pool;
    IPoolVault public poolVault;
    IERC20 public asset;

    uint256 public processedLoss;

    mapping(address => LossCoverFund) public operatorConfigs;
    mapping(address => uint256) public amounts;
    LossCoverPayout public lossCoverPayoutConfig;

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

    function setPayoutConfig(LossCoverPayout memory config) external {
        poolConfig.onlyPoolOwner(msg.sender);
        lossCoverPayoutConfig = config;

        emit PayoutConfigSet(config.coverRateInBps, config.coverCap);
    }

    function setOperator(address account, LossCoverFund memory config) external {
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
        uint256 userBalance = amounts[msg.sender];
        if (userBalance < amount) revert Errors.withdrawnAmountHigherThanBalance();
        uint256 balance = asset.balanceOf(address(this));
        if (balance < amount) revert Errors.insufficientTotalBalance();

        uint256 min = _getMinAmount(msg.sender);
        if (userBalance - amount < min) revert Errors.lessThanRequiredCover();

        userBalance -= amount;
        asset.transfer(receiver, amount);

        emit CoverRemoved(msg.sender, amount, receiver);
    }

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        poolConfig.onlyPool(msg.sender);

        LossCoverPayout memory config = lossCoverPayoutConfig;
        uint256 processed = (poolAssets * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        processed = processed < config.coverCap ? processed : config.coverCap;

        uint256 assets = asset.balanceOf(address(this));
        processed = processed < assets ? processed : assets;
        remainingLoss = loss - processed;
        if (processed > 0) {
            processedLoss += processed;
            poolVault.deposit(address(this), processed);
        }

        emit LossCovered(processed, remainingLoss);
    }

    function calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) external view returns (uint256 remainingLoss) {}

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        poolConfig.onlyPool(msg.sender);

        uint256 processed = processedLoss;
        uint256 recovered = processed < recovery ? processed : recovery;
        // There may be multiple loss coverers, the remainingRecovery may be positive.
        remainingRecovery = recovery - recovered;
        if (recovered > 0) {
            processedLoss = processed - recovered;
            poolVault.withdraw(address(this), recovered);
        }

        emit LossRecovered(recovered, remainingRecovery);
    }

    function calcLossRecover(uint256 recovery) external view returns (uint256 remainingRecovery) {}

    function isSufficient(address account) external view returns (bool) {
        _onlyOperator(account);

        uint256 userBalance = amounts[account];
        uint256 min = _getMinAmount(account);
        return userBalance >= min;
    }

    function removable(address account) external view returns (uint256 amount) {
        uint256 userBalance = amounts[msg.sender];
        uint256 min = _getMinAmount(account);

        amount = userBalance > min ? userBalance - min : 0;
    }

    function getPayoutConfig() external view returns (uint256 coverRateInBps, uint256 coverCap) {
        LossCoverPayout memory config = lossCoverPayoutConfig;
        coverRateInBps = config.coverRateInBps;
        coverCap = config.coverCap;
    }

    function _onlyOperator(address account) internal view {
        LossCoverFund memory config = operatorConfigs[account];
        if (config.poolCapCoverageInBps == 0 && config.poolValueCoverageInBps == 0)
            revert Errors.notOperator();
    }

    function _getMinAmount(address account) internal view returns (uint256 amount) {
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        LossCoverFund memory config = operatorConfigs[account];
        uint256 poolCap = lpConfig.liquidityCap;
        uint256 minFromPoolCap = (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * config.poolValueCoverageInBps) /
            HUNDRED_PERCENT_IN_BPS;
        amount = minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;
    }
}
