// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {AFFILIATE_FIRST_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "../common/SharedDefs.sol";
import {PoolConfig, AdminRnR} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {HumaConfig} from "../common/HumaConfig.sol";
import {Errors} from "../common/Errors.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "hardhat/console.sol";

contract PoolFeeManager is PoolConfigCache, IPoolFeeManager {
    using SafeERC20 for IERC20;

    struct AccruedIncomes {
        uint96 protocolIncome;
        uint96 poolOwnerIncome;
        uint96 eaIncome;
    }

    HumaConfig public humaConfig;
    IPoolSafe public poolSafe;
    IPool public pool;
    IFirstLossCover public firstLossCover;
    IERC20 public underlyingToken;

    AccruedIncomes internal _accruedIncomes;
    uint256 public protocolIncomeWithdrawn;
    uint256 public poolOwnerIncomeWithdrawn;
    uint256 public eaIncomeWithdrawn;

    event IncomeDistributed(
        uint256 protocolIncome,
        uint256 poolOwnerIncome,
        uint256 eaIncome,
        uint256 remaining,
        uint256 accruedProtocolIncome,
        uint256 accruedPoolOwnerIncome,
        uint256 accruedEAIncome
    );

    event PoolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event ProtocolRewardsWithdrawn(address receiver, uint256 amount, address by);
    event EvaluationAgentRewardsWithdrawn(address receiver, uint256 amount, address by);

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address oldUnderlyingToken = address(underlyingToken);
        address newUnderlyingToken = _poolConfig.underlyingToken();
        assert(newUnderlyingToken != address(0));
        underlyingToken = IERC20(newUnderlyingToken);

        address addr = _poolConfig.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = address(_poolConfig.humaConfig());
        assert(addr != address(0));
        humaConfig = HumaConfig(addr);

        address oldFirstLossCover = address(firstLossCover);
        addr = _poolConfig.getFirstLossCover(AFFILIATE_FIRST_LOSS_COVER_INDEX);
        assert(addr != address(0));
        firstLossCover = IFirstLossCover(addr);
        _resetFirstLossCoverAllowance(
            oldFirstLossCover,
            addr,
            oldUnderlyingToken,
            newUnderlyingToken
        );
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
            remaining,
            accruedIncomes.protocolIncome,
            accruedIncomes.poolOwnerIncome,
            accruedIncomes.eaIncome
        );

        return remaining;
    }

    function withdrawProtocolFee(uint256 amount) external {
        if (msg.sender != humaConfig.owner()) revert Errors.notProtocolOwner();
        // Invests available fees in FirstLossCover first
        AccruedIncomes memory incomes = _investFeesInFirstLossCover();
        uint256 incomeWithdrawn = protocolIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.protocolIncome)
            revert Errors.insufficientAmountForRequest();

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
        address poolOwnerTreasury = _onlyPoolOwnerTreasury(msg.sender);
        // Invests available fees in FirstLossCover first
        AccruedIncomes memory incomes = _investFeesInFirstLossCover();
        // Checks if the required cover is sufficient
        if (!firstLossCover.isSufficient()) revert Errors.lessThanRequiredCover();

        uint256 incomeWithdrawn = poolOwnerIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.poolOwnerIncome)
            revert Errors.insufficientAmountForRequest();

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
        if (!firstLossCover.isSufficient()) revert Errors.lessThanRequiredCover();

        uint256 incomeWithdrawn = eaIncomeWithdrawn;
        if (incomeWithdrawn + amount > incomes.eaIncome)
            revert Errors.insufficientAmountForRequest();

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
        protocolWithdrawable = incomes.protocolIncome - protocolWithdrawn;

        uint256 poolOwnerWithdrawn = poolOwnerIncomeWithdrawn;
        poolOwnerWithdrawable = incomes.poolOwnerIncome - poolOwnerWithdrawn;

        uint256 eaWithdrawn = eaIncomeWithdrawn;
        eaWithdrawable = incomes.eaIncome - eaWithdrawn;
    }

    /**
     * @notice PoolOwner can call this function to know if there are some available fees to be able to invested in FirstLossCover.
     */
    function getAvailableFeesToInvestInFirstLossCover() external view returns (uint256 fees) {
        (fees, ) = _getAvailableFeesToInvestInFirstLossCover();
    }

    /**
     * @notice Invests available fees in FirstLossCover.
     * @custom:access Only the pool owner or the Sentinel Service account can call this function.
     */
    function investFeesInFirstLossCover() external {
        poolConfig.onlyPoolOwnerOrSentinelServiceAccount(msg.sender);
        _investFeesInFirstLossCover();
    }

    /**
     * @notice Resets the allowance of the old first loss cover to 0 and approve a new allowance
     * for the new first loss cover.
     * @dev This function is called when setting the first loss cover address in `_updatePoolConfigData()`,
     * and is needed because the first loss cover needs
     */
    function _resetFirstLossCoverAllowance(
        address oldFirstLossCover,
        address newFirstLossCover,
        address oldUnderlyingToken,
        address newUnderlyingToken
    ) internal {
        if (oldFirstLossCover == newFirstLossCover && oldUnderlyingToken == newUnderlyingToken) {
            // No need to do anything if none of the addresses changed.
            return;
        }
        if (oldFirstLossCover != address(0) && oldUnderlyingToken != address(0)) {
            // Old first loss cover address and the old underlying token address may be 0 if this is
            // the first ever initialization of the contract.
            uint256 allowance = IERC20(oldUnderlyingToken).allowance(
                address(this),
                oldFirstLossCover
            );
            IERC20(oldUnderlyingToken).safeDecreaseAllowance(oldFirstLossCover, allowance);
        }
        // The caller should have checked that the new underlying token and new first loss cover
        // are not zero-addresses.
        assert(newFirstLossCover != address(0));
        assert(newUnderlyingToken != address(0));
        IERC20(newUnderlyingToken).safeIncreaseAllowance(newFirstLossCover, type(uint256).max);
    }

    function _investFeesInFirstLossCover() internal returns (AccruedIncomes memory incomes) {
        (
            uint256 feesLiquidity,
            AccruedIncomes memory availableIncomes
        ) = _getAvailableFeesToInvestInFirstLossCover();
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
    function _getAvailableFeesToInvestInFirstLossCover()
        internal
        view
        returns (uint256 availableFees, AccruedIncomes memory availableIncomes)
    {
        availableIncomes = _getAvailableIncomes();
        uint256 availableTotalFees = availableIncomes.protocolIncome +
            availableIncomes.poolOwnerIncome +
            availableIncomes.eaIncome;
        uint256 availableCap = firstLossCover.getAvailableCap();
        availableFees = availableTotalFees > availableCap ? availableCap : availableTotalFees;
        uint256 availableBalance = poolSafe.getAvailableBalanceForFees();
        availableFees = availableFees > availableBalance ? availableBalance : availableFees;
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

    function _onlyPoolOwnerTreasury(address account) internal view returns (address) {
        address tempPoolOwnerTreasury = poolConfig.poolOwnerTreasury();
        if (account != tempPoolOwnerTreasury) revert Errors.notAuthorizedCaller();
        return tempPoolOwnerTreasury;
    }
}
