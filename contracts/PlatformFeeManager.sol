// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "./Constants.sol";
import {PoolConfig, PoolSettings} from "./PoolConfig.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {HumaConfig} from "./HumaConfig.sol";
import {Errors} from "./Errors.sol";

contract PlatformFeeManager {
    struct AccruedIncomes {
        uint96 protocolIncome;
        uint96 poolOwnerIncome;
        uint96 eaIncome;
    }

    PoolConfig public poolConfig;
    HumaConfig public humaConfig;
    IPoolVault public poolVault;

    AccruedIncomes internal _accruedIncomes;
    uint256 public protocolIncomeWithdrawn;
    uint256 public poolOwnerIncomeWithdrawn;
    uint256 public eaIncomeWithdrawn;

    // TODO permission
    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig = _poolConfig;

        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = address(_poolConfig.humaConfig());
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        humaConfig = HumaConfig(addr);
    }

    // TODO migration function

    function distributePlatformFees(uint256 profit) external {
        (AccruedIncomes memory incomes, ) = _getPlatformFees(profit);
        AccruedIncomes memory accruedIncomes = _accruedIncomes;

        accruedIncomes.protocolIncome += incomes.protocolIncome;
        accruedIncomes.poolOwnerIncome += incomes.poolOwnerIncome;
        accruedIncomes.eaIncome += incomes.eaIncome;

        _accruedIncomes = accruedIncomes;
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
        if (amount + incomeWithdrawn > incomes.protocolIncome)
            revert Errors.withdrawnAmountHigherThanBalance();
        protocolIncomeWithdrawn = incomeWithdrawn + amount;

        address treasuryAddress = humaConfig.humaTreasury();
        // It is possible that Huma protocolTreasury is missed in the setup. If that happens,
        // the transaction is reverted. The protocol owner can still withdraw protocol fee
        // after protocolTreasury is configured in HumaConfig.
        assert(treasuryAddress != address(0));

        poolVault.withdrawFees(treasuryAddress, amount);
    }

    function withdrawPoolOwnerFee(uint256 amount) external {
        address treasury = poolConfig.onlyPoolOwnerTreasury(msg.sender);
        if (amount == 0) revert Errors.zeroAmountProvided();
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = poolOwnerIncomeWithdrawn;
        if (amount + incomeWithdrawn > incomes.poolOwnerIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        poolOwnerIncomeWithdrawn = incomeWithdrawn + amount;
        poolVault.withdrawFees(treasury, amount);
    }

    function withdrawEAFee(uint256 amount) external {
        // Either Pool owner or EA can trigger reward withdraw for EA.
        // When it is triggered by pool owner, the fund still flows to the EA's account.
        address treasury = poolConfig.onlyPoolOwnerOrEA(msg.sender);
        if (amount == 0) revert Errors.zeroAmountProvided();
        AccruedIncomes memory incomes = _accruedIncomes;
        uint256 incomeWithdrawn = eaIncomeWithdrawn;
        if (amount + incomeWithdrawn > incomes.eaIncome)
            revert Errors.withdrawnAmountHigherThanBalance();

        eaIncomeWithdrawn = incomeWithdrawn + amount;
        poolVault.withdrawFees(treasury, amount);
    }

    function _getPlatformFees(
        uint256 profit
    ) internal view returns (AccruedIncomes memory incomes, uint256 remaining) {
        PoolSettings memory settings = poolConfig.getPoolSettings();

        uint256 income = (humaConfig.protocolFee() * profit) / HUNDRED_PERCENT_IN_BPS;
        incomes.protocolIncome = uint96(income);

        remaining = profit - income;

        income = (remaining * settings.rewardRateInBpsForPoolOwner) / HUNDRED_PERCENT_IN_BPS;
        incomes.poolOwnerIncome = uint96(income);

        income = (remaining * settings.rewardRateInBpsForEA) / HUNDRED_PERCENT_IN_BPS;
        incomes.eaIncome = uint96(income);

        remaining -= incomes.poolOwnerIncome + incomes.eaIncome;
    }
}
