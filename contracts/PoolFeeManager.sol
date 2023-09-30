// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SharedDefs.sol";
import {PoolConfig, PoolSettings, AdminRnR} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";

contract PoolFeeManager is PoolConfigCache, IPoolFeeManager {
    struct AccruedIncomes {
        uint96 protocolIncome;
        uint96 poolOwnerIncome;
        uint96 eaIncome;
    }

    HumaConfig public humaConfig;
    IPoolSafe public poolSafe;
    IFirstLossCover public firstLossCover;

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

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);

        addr = _poolConfig.getFirstLossCover(AFFILIATE_FIRST_LOSS_COVER_INDEX);
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        firstLossCover = IFirstLossCover(addr);
    }

    function distributePoolFees(uint256 profit) external returns (uint256) {
        poolConfig.onlyPool(msg.sender);

        (AccruedIncomes memory incomes, uint256 remaining) = _getPoolFees(profit);
        uint256 totalFees = incomes.protocolIncome + incomes.poolOwnerIncome + incomes.eaIncome;
        uint256 liquidityCapacity = firstLossCover.availableLiquidityCapacity();

        if (liquidityCapacity > totalFees) {
            // TODO these deposits are expensive, it is better to move them to an autotask
            firstLossCover.depositCoverWithAffiliateFees(
                incomes.protocolIncome,
                humaConfig.humaTreasury()
            );
            firstLossCover.depositCoverWithAffiliateFees(
                incomes.poolOwnerIncome,
                poolConfig.poolOwnerTreasury()
            );
            firstLossCover.depositCoverWithAffiliateFees(
                incomes.eaIncome,
                poolConfig.evaluationAgent()
            );
        } else {
            if (liquidityCapacity > 0) {
                // TODO these deposits are expensive, it is better to move them to an autotask
                uint256 poolOwnerFees = (incomes.poolOwnerIncome * liquidityCapacity) / totalFees;
                firstLossCover.depositCoverWithAffiliateFees(
                    poolOwnerFees,
                    poolConfig.poolOwnerTreasury()
                );
                uint256 eaFees = (incomes.eaIncome * liquidityCapacity) / totalFees;
                firstLossCover.depositCoverWithAffiliateFees(eaFees, poolConfig.evaluationAgent());
                uint256 protocolFees = liquidityCapacity - poolOwnerFees - eaFees;
                firstLossCover.depositCoverWithAffiliateFees(
                    protocolFees,
                    humaConfig.humaTreasury()
                );

                uint256 remainingFees = totalFees - liquidityCapacity;
                incomes.poolOwnerIncome = uint96(
                    (incomes.poolOwnerIncome * remainingFees) / totalFees
                );
                incomes.eaIncome = uint96((incomes.eaIncome * remainingFees) / totalFees);
                incomes.protocolIncome = uint96(
                    remainingFees - incomes.poolOwnerIncome - incomes.eaIncome
                );
            }

            AccruedIncomes memory accruedIncomes = _accruedIncomes;
            accruedIncomes.protocolIncome += incomes.protocolIncome;
            accruedIncomes.poolOwnerIncome += incomes.poolOwnerIncome;
            accruedIncomes.eaIncome += incomes.eaIncome;
            _accruedIncomes = accruedIncomes;

            emit IncomeDistributed(
                incomes.protocolIncome,
                incomes.poolOwnerIncome,
                incomes.eaIncome,
                remaining
            );
        }

        return remaining;
    }

    function calcPlatformFeeDistribution(
        uint256 profit
    ) external view returns (uint256 remaining) {
        (, remaining) = _getPoolFees(profit);
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

        poolSafe.withdraw(treasuryAddress, amount);
        emit ProtocolRewardsWithdrawn(treasuryAddress, amount, msg.sender);
    }

    function withdrawPoolOwnerFee(uint256 amount) external {
        address treasury = poolConfig.onlyPoolOwnerTreasury(msg.sender);
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = poolOwnerIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.poolOwnerIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        poolOwnerIncomeWithdrawn = incomeWithdrawn + amount;
        poolSafe.withdraw(treasury, amount);
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
        poolSafe.withdraw(treasury, amount);
        emit EvaluationAgentRewardsWithdrawn(treasury, amount, msg.sender);
    }

    function getAccruedIncomes() external view returns (AccruedIncomes memory) {
        return _accruedIncomes;
    }

    function getTotalAvailableFees() external view returns (uint256) {
        AccruedIncomes memory incomes = _accruedIncomes;
        return
            incomes.protocolIncome +
            incomes.poolOwnerIncome +
            incomes.eaIncome -
            protocolIncomeWithdrawn -
            poolOwnerIncomeWithdrawn -
            eaIncomeWithdrawn;
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

    /**
     * @notice Returns the incomes of the Huma protocol, pool owner and EA and the remaining profit
     * after deducting the incomes as fees.
     */
    function _getPoolFees(
        uint256 profit
    ) internal view returns (AccruedIncomes memory incomes, uint256 remaining) {
        AdminRnR memory adminRnR = poolConfig.getAdminRnR();

        uint256 income = (humaConfig.protocolFeeInBps() * profit) / HUNDRED_PERCENT_IN_BPS;
        incomes.protocolIncome = uint96(income);

        remaining = profit - income;

        income = (remaining * adminRnR.rewardRateInBpsForPoolOwner) / HUNDRED_PERCENT_IN_BPS;
        incomes.poolOwnerIncome = uint96(income);

        income = (remaining * adminRnR.rewardRateInBpsForEA) / HUNDRED_PERCENT_IN_BPS;
        incomes.eaIncome = uint96(income);

        remaining -= incomes.poolOwnerIncome + incomes.eaIncome;
        return (incomes, remaining);
    }
}
