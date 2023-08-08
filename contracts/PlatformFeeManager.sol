// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SharedDefs.sol";
import {PoolConfig, PoolSettings, AdminRnR} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";

contract PlatformFeeManager is PoolConfigCache, IPlatformFeeManager {
    struct AccruedIncomes {
        uint96 protocolIncome;
        uint96 poolOwnerIncome;
        uint96 eaIncome;
    }

    HumaConfig public humaConfig;
    IPoolVault public poolVault;
    AccruedIncomes internal _accruedIncomes;
    uint256 public protocolIncomeWithdrawn;
    uint256 public poolOwnerIncomeWithdrawn;
    uint256 public eaIncomeWithdrawn;

    event IncomeDistributed(
        uint256 protocolFee,
        uint256 ownerIncome,
        uint256 eaIncome,
        uint256 poolIncome
    );

    event PoolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event ProtocolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event EvaluationAgentRewardsWithdrawn(address receiver, uint256 amount, address by);

    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);
    }

    function distributePlatformFees(uint256 profit) external returns (uint256) {
        poolConfig.onlyPool(msg.sender);

        (AccruedIncomes memory incomes, uint256 remaining) = _getPlatformFees(profit);
        AccruedIncomes memory accruedIncomes = _accruedIncomes;

        accruedIncomes.protocolIncome += incomes.protocolIncome;
        accruedIncomes.poolOwnerIncome += incomes.poolOwnerIncome;
        accruedIncomes.eaIncome += incomes.eaIncome;

        _accruedIncomes = accruedIncomes;
        poolVault.addPlatformFeesReserve(
            incomes.protocolIncome + incomes.poolOwnerIncome + incomes.eaIncome
        );

        emit IncomeDistributed(
            incomes.protocolIncome,
            incomes.poolOwnerIncome,
            incomes.eaIncome,
            remaining
        );

        return remaining;
    }

    function getRemainingAfterPlatformFees(
        uint256 profit
    ) external view returns (uint256 remaining) {
        (, remaining) = _getPlatformFees(profit);
    }

    function withdrawProtocolFee(uint256 amount) external {
        if (msg.sender != humaConfig.owner()) revert Errors.notProtocolOwner();
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = protocolIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.protocolIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        protocolIncomeWithdrawn = incomeWithdrawn + amount;

        address treasuryAddress = humaConfig.humaTreasury();
        // It is possible that Huma protocolTreasury is missed in the setup. If that happens,
        // the transaction is reverted. The protocol owner can still withdraw protocol fee
        // after protocolTreasury is configured in HumaConfig.
        assert(treasuryAddress != address(0));

        poolVault.withdrawFees(treasuryAddress, amount);
        emit ProtocolRewardsWithdrawn(treasuryAddress, amount, msg.sender);
    }

    function withdrawPoolOwnerFee(uint256 amount) external {
        address treasury = poolConfig.onlyPoolOwnerTreasury(msg.sender);
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = poolOwnerIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.poolOwnerIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        poolOwnerIncomeWithdrawn = incomeWithdrawn + amount;
        poolVault.withdrawFees(treasury, amount);
        emit PoolRewardsWithdrawn(treasury, amount, msg.sender);
    }

    function withdrawEAFee(uint256 amount) external {
        // Either Pool owner or EA can trigger reward withdraw for EA.
        // When it is triggered by pool owner, the fund still flows to the EA's account.
        address treasury = poolConfig.onlyPoolOwnerOrEA(msg.sender);
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = eaIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.eaIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        eaIncomeWithdrawn = incomeWithdrawn + amount;
        poolVault.withdrawFees(treasury, amount);
        emit EvaluationAgentRewardsWithdrawn(treasury, amount, msg.sender);
    }

    function getAccruedIncomes() external view returns (AccruedIncomes memory) {
        return _accruedIncomes;
    }

    function getWithdrawables()
        external
        view
        returns (
            uint256 protocolWithdrawable,
            uint256 poolOwnerWithdrawable,
            uint256 eaWithdrawable
        )
    {
        AccruedIncomes memory incomes = _accruedIncomes;

        uint256 protocolWithdrawn = protocolIncomeWithdrawn;
        protocolWithdrawable = incomes.protocolIncome < protocolWithdrawn
            ? 0
            : incomes.protocolIncome - protocolWithdrawn;

        uint256 poolOwnerWithdrawn = poolOwnerIncomeWithdrawn;
        poolOwnerWithdrawable = incomes.poolOwnerIncome < poolOwnerWithdrawn
            ? 0
            : incomes.poolOwnerIncome - poolOwnerWithdrawn;

        uint256 eaWithdrawn = eaIncomeWithdrawn;
        eaWithdrawable = incomes.eaIncome < eaWithdrawn ? 0 : incomes.eaIncome - eaWithdrawn;
    }

    function _getPlatformFees(
        uint256 profit
    ) internal view returns (AccruedIncomes memory incomes, uint256 remaining) {
        AdminRnR memory adminRnR = poolConfig.getAdminRnR();

        uint256 income = (humaConfig.protocolFee() * profit) / HUNDRED_PERCENT_IN_BPS;
        incomes.protocolIncome = uint96(income);

        remaining = profit - income;

        income = (remaining * adminRnR.rewardRateInBpsForPoolOwner) / HUNDRED_PERCENT_IN_BPS;
        incomes.poolOwnerIncome = uint96(income);

        income = (remaining * adminRnR.rewardRateInBpsForEA) / HUNDRED_PERCENT_IN_BPS;
        incomes.eaIncome = uint96(income);

        remaining -= incomes.poolOwnerIncome + incomes.eaIncome;
    }
}
