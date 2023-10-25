// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig, CreditRecord, CreditState} from "../CreditStructs.sol";
import {PoolConfig, PoolSettings} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import {HUNDRED_PERCENT_IN_BPS, SECONDS_IN_A_DAY, SECONDS_IN_A_YEAR} from "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

import "hardhat/console.sol";

contract CreditFeeManager is PoolConfigCache, ICreditFeeManager {
    ICalendar public calendar;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /// @inheritdoc ICreditFeeManager
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditRecord memory dealRecord
    ) external view virtual returns (uint256 accruedInterest, uint256 accruedPrincipal) {}

    /// @inheritdoc ICreditFeeManager
    function calcYieldDuePerPeriod(
        uint256 principal,
        uint256 baseYieldInBps,
        uint256 periodDuration,
        bool isLate
    ) public view virtual override returns (uint256 yieldDue) {
        (uint256 lateFeeFlat, uint256 lateFeeBps, uint256 membershipFee) = poolConfig.getFees();
        if (isLate) {
            yieldDue = lateFeeFlat + membershipFee;
            yieldDue +=
                (principal * (baseYieldInBps + lateFeeBps) * periodDuration) /
                HUNDRED_PERCENT_IN_BPS /
                12;
        } else {
            yieldDue =
                membershipFee +
                (principal * baseYieldInBps * periodDuration) /
                HUNDRED_PERCENT_IN_BPS /
                12;
        }
        return yieldDue;
    }

    /// @inheritdoc ICreditFeeManager
    function calcFrontLoadingFee(
        uint256 _amount
    ) public view virtual override returns (uint256 fees) {
        uint256 frontLoadingFeeBps;
        (fees, frontLoadingFeeBps) = poolConfig.getFrontLoadingFees();
        if (frontLoadingFeeBps > 0)
            fees += (_amount * frontLoadingFeeBps) / HUNDRED_PERCENT_IN_BPS;
    }

    /// @inheritdoc ICreditFeeManager
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view virtual returns (uint256 amtToBorrower, uint256 platformFees) {
        // Calculate platform fee, which includes protocol fee and pool fee
        platformFees = calcFrontLoadingFee(borrowAmount);

        if (borrowAmount < platformFees) revert Errors.borrowingAmountLessThanPlatformFees();

        amtToBorrower = borrowAmount - platformFees;

        return (amtToBorrower, platformFees);
    }

    /// @inheritdoc ICreditFeeManager
    function setFees(
        uint256 _frontLoadingFeeFlat,
        uint256 _frontLoadingFeeBps,
        uint256 _lateFeeFlat,
        uint256 _lateFeeBps,
        uint256 _membershipFee
    ) external {}

    /// @inheritdoc ICreditFeeManager
    function setMinPrincipalRateInBps(uint256 _minPrincipalRateInBps) external {}

    /// @inheritdoc ICreditFeeManager
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc
    )
        public
        view
        virtual
        override
        returns (CreditRecord memory newCR, uint256 periodsPassed, bool isLate)
    {
        //* todo Right now, need to handle middle month, middle quarter cases

        // No need to update if it is still within a period from the last processing
        if (block.timestamp <= _cr.nextDueDate) return (_cr, 0, false);

        PoolSettings memory settings = poolConfig.getPoolSettings();

        // If the due is nonzero and has passed late payment grace period, the account is late
        isLate = (_cr.totalDue != 0 &&
            block.timestamp >
            _cr.nextDueDate + settings.latePaymentGracePeriodInDays * SECONDS_IN_A_DAY);

        // No need to update if it is still within grace period
        if ((_cr.totalDue != 0 && !isLate)) {
            return (_cr, 0, false);
        }

        newCR = CreditRecord(
            _cr.unbilledPrincipal,
            _cr.nextDueDate,
            _cr.totalDue,
            _cr.yieldDue,
            _cr.missedPeriods,
            _cr.remainingPeriods,
            _cr.state
        );

        uint256 newDueDate;
        (newDueDate, periodsPassed) = calendar.getNextDueDate(
            _cc.periodDuration,
            newCR.nextDueDate
        );
        newCR.nextDueDate = uint64(newDueDate);

        uint256 principal = newCR.unbilledPrincipal + newCR.totalDue - newCR.yieldDue;

        // Note that if multiple periods have passed, the yield for every period is still based on the
        // outstanding principal since there was no change to the principal
        uint256 yieldDue = calcYieldDuePerPeriod(
            principal,
            _cc.yieldInBps,
            _cc.periodDuration,
            isLate
        ) * periodsPassed;

        uint256 principalDue = 0;
        uint256 principalRate = poolConfig.getMinPrincipalRateInBps();
        if (principalRate > 0) {
            // Note that if the principalRate is R, the remaining principal rate is (1 - R).
            // When multiple periods P passed, the remaining principal rate is (1 - R)^P.
            // The incremental principal due should be 1 - (1 - R)^P.
            principalDue =
                ((HUNDRED_PERCENT_IN_BPS ** periodsPassed -
                    (HUNDRED_PERCENT_IN_BPS - poolConfig.getMinPrincipalRateInBps()) **
                        periodsPassed) * principal) /
                (HUNDRED_PERCENT_IN_BPS ** periodsPassed);
        }
        newCR.yieldDue = uint96(newCR.yieldDue + yieldDue);
        newCR.totalDue = uint96(newCR.totalDue + yieldDue + principalDue);
        newCR.unbilledPrincipal = uint96(newCR.unbilledPrincipal - principalDue);

        // If passed final period, all principal is due
        if (periodsPassed >= newCR.remainingPeriods) {
            newCR.totalDue += newCR.unbilledPrincipal;
            newCR.unbilledPrincipal = 0;
        }

        return (newCR, periodsPassed, isLate);
    }

    function getPayoffAmount(
        CreditRecord memory cr,
        uint256 yieldInBps
    ) external view virtual override returns (uint256 payoffAmount) {
        uint256 principal = cr.unbilledPrincipal + cr.totalDue - cr.yieldDue;
        payoffAmount = uint256(cr.totalDue + cr.unbilledPrincipal);
        if (block.timestamp < cr.nextDueDate) {
            // Subtract the yield for the days between the current date and the due date when payment is made
            // in advance of the due date.
            uint256 remainingYield = (yieldInBps *
                principal *
                (cr.nextDueDate - block.timestamp)) / (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS);
            assert(payoffAmount >= remainingYield);
            payoffAmount -= remainingYield;
        }
    }
}
