// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./SharedDefs.sol";
import {PoolConfig, PoolSettings, AdminRnR} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPool} from "./interfaces/IPool.sol";
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
    IPool public pool;
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

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

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

        return remaining;
    }

    function calcPoolFeeDistribution(uint256 profit) external view returns (uint256 remaining) {
        (, remaining) = _getPoolFees(profit);
    }

    function withdrawProtocolFee(uint256 amount) external {
        if (msg.sender != humaConfig.owner()) revert Errors.notProtocolOwner();
        // Invests available fees in FirstLossCover first
        AccruedIncomes memory incomes = _investFeesInFirstLossCover();
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
        address poolOwnerTreasury = poolConfig.onlyPoolOwnerTreasury(msg.sender);
        // Invests available fees in FirstLossCover first
        AccruedIncomes memory incomes = _investFeesInFirstLossCover();
        // Checks if the required cover is sufficient
        if (!firstLossCover.isSufficient(poolOwnerTreasury)) revert Errors.lessThanRequiredCover();

        uint256 incomeWithdrawn = poolOwnerIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.poolOwnerIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        poolOwnerIncomeWithdrawn = incomeWithdrawn + amount;
        poolSafe.withdraw(poolOwnerTreasury, amount);
        emit PoolRewardsWithdrawn(poolOwnerTreasury, amount, msg.sender);
    }

    function withdrawEAFee(uint256 amount) external {
        // Either Pool owner or EA can trigger reward withdraw for EA.
        // When it is triggered by pool owner, the fund still flows to the EA's account.
        address ea = poolConfig.onlyPoolOwnerOrEA(msg.sender);
        // Invests available fees in FirstLossCover first
        AccruedIncomes memory incomes = _investFeesInFirstLossCover();
        // Checks if the required cover is sufficient
        if (!firstLossCover.isSufficient(ea)) revert Errors.lessThanRequiredCover();

        uint256 incomeWithdrawn = eaIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.eaIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        eaIncomeWithdrawn = incomeWithdrawn + amount;
        poolSafe.withdraw(ea, amount);
        emit EvaluationAgentRewardsWithdrawn(ea, amount, msg.sender);
    }

    function getAccruedIncomes() external view returns (AccruedIncomes memory) {
        return _accruedIncomes;
    }

    /// @inheritdoc IPoolFeeManager
    function getTotalAvailableFees() public view returns (uint256) {
        AccruedIncomes memory incomes = _getAvailableIncomes();
        return incomes.protocolIncome + incomes.poolOwnerIncome + incomes.eaIncome;
    }

    function _getAvailableIncomes() internal view returns (AccruedIncomes memory incomes) {
        incomes = _accruedIncomes;
        incomes.protocolIncome = incomes.protocolIncome - uint96(protocolIncomeWithdrawn);
        incomes.poolOwnerIncome = incomes.poolOwnerIncome - uint96(poolOwnerIncomeWithdrawn);
        incomes.eaIncome = incomes.eaIncome - uint96(eaIncomeWithdrawn);
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
     * @notice PoolOwner can call this function to know if there are some available fees to be able to invested in FirstLossCover.
     */
    function getAvailableFeesToInvestInFirstLossCover() external view returns (uint256 fees) {
        (fees, ) = _getAvailableFeesToInvestInFirstLossCover(pool.totalAssets());
    }

    /**
     * @notice PoolOwner calls this function to invest available fees in FirstLossCover
     * while getAvailableFeesToInvestInFirstLossCover returns a positive value.
     */
    function investFeesInFirstLossCover() external {
        poolConfig.onlyPoolOwner(msg.sender);
        _investFeesInFirstLossCover();
    }

    function _investFeesInFirstLossCover() internal returns (AccruedIncomes memory incomes) {
        uint96[2] memory assets = pool.refreshPool();
        (
            uint256 feesLiquidity,
            AccruedIncomes memory availableIncomes
        ) = _getAvailableFeesToInvestInFirstLossCover(
                assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE]
            );
        if (feesLiquidity == 0) return _accruedIncomes;

        // Transfers tokens from PoolSafe to this contract, firstLossCover will transfer token from this contract
        // to itself while calling depositCoverFor.
        poolSafe.withdraw(address(this), feesLiquidity);
        uint256 totalAvailableFees = availableIncomes.protocolIncome +
            availableIncomes.poolOwnerIncome +
            availableIncomes.eaIncome;
        incomes = _accruedIncomes;

        uint256 poolOwnerFees = (availableIncomes.poolOwnerIncome * feesLiquidity) /
            totalAvailableFees;
        firstLossCover.depositCoverFor(poolOwnerFees, poolConfig.poolOwnerTreasury());
        uint256 eaFees = (availableIncomes.eaIncome * feesLiquidity) / totalAvailableFees;
        firstLossCover.depositCoverFor(eaFees, poolConfig.evaluationAgent());
        uint256 protocolFees = feesLiquidity - poolOwnerFees - eaFees;
        //* todo protocol owner needs to do this?
        firstLossCover.depositCoverFor(protocolFees, humaConfig.humaTreasury());
        incomes.protocolIncome -= uint96(protocolFees);
        incomes.poolOwnerIncome -= uint96(poolOwnerFees);
        incomes.eaIncome -= uint96(eaFees);

        _accruedIncomes = incomes;
    }

    /**
     * @notice Returns the available fees to be invested in FirstLossCover.
     * @return availableFees The available fees which meet
     *   1. the available liquidity of PoolSafe
     *   2. the available cap of FirstLossCover
     *   3. the available value of _accruedIncomes
     * @return availableIncomes The available incomes of the Huma protocol, pool owner and EA.
     */
    function _getAvailableFeesToInvestInFirstLossCover(
        uint256 poolAssets
    ) internal view returns (uint256 availableFees, AccruedIncomes memory availableIncomes) {
        availableIncomes = _getAvailableIncomes();
        uint256 availableTotalFees = availableIncomes.protocolIncome +
            availableIncomes.poolOwnerIncome +
            availableIncomes.eaIncome;
        uint256 availableCap = pool.getFirstLossCoverAvailableCap(
            address(firstLossCover),
            poolAssets
        );
        availableFees = availableTotalFees > availableCap ? availableCap : availableTotalFees;
        uint256 availableLiquidity = poolSafe.getAvailableLiquidityForFees();
        availableFees = availableFees > availableLiquidity ? availableLiquidity : availableFees;
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
