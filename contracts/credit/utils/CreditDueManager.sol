// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {CreditConfig, CreditRecord, CreditState, DueDetail} from "../CreditStructs.sol";
import {PoolConfig, PoolSettings} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import {DAYS_IN_A_MONTH, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, MONTHS_IN_A_YEAR, SECONDS_IN_A_DAY, SECONDS_IN_A_YEAR} from "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

import "hardhat/console.sol";

contract CreditDueManager is PoolConfigCache, ICreditDueManager {
    ICalendar public calendar;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /// @inheritdoc ICreditDueManager
    function calcFrontLoadingFee(
        uint256 _amount
    ) public view virtual override returns (uint256 fees) {
        uint256 frontLoadingFeeBps;
        (fees, frontLoadingFeeBps) = poolConfig.getFrontLoadingFees();
        if (frontLoadingFeeBps > 0)
            fees += (_amount * frontLoadingFeeBps) / HUNDRED_PERCENT_IN_BPS;
        return fees;
    }

    /// @inheritdoc ICreditDueManager
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view virtual returns (uint256 amtToBorrower, uint256 platformFees) {
        // Calculate platform fee, which includes protocol fee and pool fee
        platformFees = calcFrontLoadingFee(borrowAmount);
        if (borrowAmount < platformFees) revert Errors.borrowingAmountLessThanPlatformFees();
        amtToBorrower = borrowAmount - platformFees;
        return (amtToBorrower, platformFees);
    }

    function checkIsLate(CreditRecord memory _cr) public view returns (bool isLate) {
        // TODO(jiatu): should we check cr.state instead? Feels more explicit that way.
        if (_cr.missedPeriods > 0) return true;

        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        return
            _cr.nextDue != 0 &&
            block.timestamp >
            _cr.nextDueDate + poolSettings.latePaymentGracePeriodInDays * SECONDS_IN_A_DAY;
    }

    function getNextBillRefreshDate(
        CreditRecord memory _cr
    ) public view returns (uint256 refreshDate) {
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        return _cr.nextDueDate + poolSettings.latePaymentGracePeriodInDays * SECONDS_IN_A_DAY;
    }

    function refreshLateFee(
        CreditRecord memory _cr,
        DueDetail memory _dd
    ) internal view returns (uint64 lateFeeUpdatedDate, uint96 lateFee) {
        lateFeeUpdatedDate = uint64(calendar.getStartOfTomorrow());
        // TODO(jiatu): how do we deal with partial periods for the flat late fee?
        (, uint256 lateFeeInBps, ) = poolConfig.getFees();
        // If the credit state is good-standing, then the bill is late for the first time.
        // We need to charge the late fee from the last due date onwards.
        uint256 lateFeeStartDate = _cr.state == CreditState.GoodStanding
            ? _cr.nextDueDate
            : _dd.lateFeeUpdatedDate;

        lateFee = uint96(
            _dd.lateFee +
                (lateFeeInBps *
                    (_cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue) *
                    calendar.getDaysDiff(lateFeeStartDate, lateFeeUpdatedDate)) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR)
        );
        //        console.log("In refresh late fee");
        //        console.log("original late fee %d", _dd.lateFee);
        //        console.log("principal %d, late fee start date %d, late fee updated date %d", _cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue, lateFeeStartDate, lateFeeUpdatedDate);
        //        console.log("late fee %d", lateFee);
        //        console.log("~~~~~~~~~~~~~~~~~~~~~~");
        return (lateFeeUpdatedDate, lateFee);
    }

    /// @inheritdoc ICreditDueManager
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc,
        DueDetail memory _dd,
        uint256 maturityDate
    )
        public
        view
        virtual
        override
        returns (CreditRecord memory newCR, DueDetail memory newDD, bool isLate)
    {
        //* todo currently, we do not mutate the input struct param. Mutating will be more efficiency but
        // has worse readability. Let us test the mutate approach as well.
        newCR = _deepCopyCreditRecord(_cr);
        newDD = _deepCopyDueDetail(_dd);

        // If the current timestamp still falls within the late payment grace period, then all the amount due is up-to-date
        // except possibly the late fee. So we only need to update the late fee if it is already late.
        if (block.timestamp <= getNextBillRefreshDate(_cr)) {
            if (_cr.missedPeriods == 0) return (_cr, _dd, false);
            else {
                newCR.totalPastDue -= _dd.lateFee;
                (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
                newCR.totalPastDue += newDD.lateFee;
                return (newCR, newDD, true);
            }
        }

        // Update the due date.
        newCR.nextDueDate = uint64(calendar.getNextDueDate(_cc.periodDuration, maturityDate));

        // TODO(jiatu): Should we use `cr.state != CreditState.GoodStanding` instead?
        if (_cr.nextDueDate != 0) {
            // If this is not the first drawdown, then the bill must be late at this point.
            // Move all current next due to past due and calculate late fees.
            newDD.yieldPastDue += _cr.yieldDue;
            newDD.principalPastDue += _cr.nextDue - _cr.yieldDue;
            (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
            isLate = true;
        }

        uint256 principalDue = 0;
        // Calculate days overdue and days remaining until next due date to determine respective yields.
        uint256 daysOverdue;
        uint256 daysUntilNextDue;
        uint256 principalRate = poolConfig.getMinPrincipalRateInBps();
        if (_cr.nextDueDate == 0) {
            // If this is the first drawdown, then there is no past due. The number of days until next due
            // is the number of days in the first period.
            daysUntilNextDue = calendar.getDaysDiff(block.timestamp, newCR.nextDueDate);
            // Given that the billing period may start mid-period and `principalRate` is for whole periods,
            // we must calculate a prorated amount for the initial period based on the actual days.
            // For instance, if the `principalRate` is 3% for a full period, and the principal is
            // $1,000 with only 20 out of 30 days in the first billing cycle, then the prorated principal due
            // is $1,000 * 3% * (20/30), which equals $20.
            if (principalRate > 0) {
                uint256 totalDaysInFullPeriod = calendar.getTotalDaysInFullPeriod(
                    _cc.periodDuration
                );
                principalDue =
                    (_cr.unbilledPrincipal * principalRate * daysUntilNextDue) /
                    (HUNDRED_PERCENT_IN_BPS * totalDaysInFullPeriod);
                newCR.unbilledPrincipal -= uint96(principalDue);
            }
        } else if (block.timestamp > maturityDate) {
            // Post-maturity, all days from the last due date to maturity are considered overdue.
            daysOverdue = calendar.getDaysDiff(_cr.nextDueDate, maturityDate);
            // All principal is also past due in this case.
            newDD.principalPastDue += _cr.unbilledPrincipal;
            newCR.unbilledPrincipal = 0;
            //            console.log("Post maturity");
            //            console.log("_cr.nextDueDate %d", _cr.nextDueDate);
            //            console.log("days overdue %d, principal past due %d", daysOverdue, newDD.principalPastDue);
            //            console.log("********************");
        } else {
            // For intermediate billing periods, calculate `daysOverdue` as the time span between
            // the previous due date and the start date of the current billing cycle.
            // Additionally, calculate `daysUntilNextDue` as the remaining time until the due date in the current cycle.
            uint256 periodStartDate = calendar.getStartDateOfPeriod(
                _cc.periodDuration,
                block.timestamp
            );
            daysOverdue = calendar.getDaysDiff(_cr.nextDueDate, periodStartDate);
            daysUntilNextDue = calendar.getDaysDiff(periodStartDate, newCR.nextDueDate);
            // Assuming the `principalRate` is represented by R, the remaining principal rate after one period is (1 - R).
            // When P full periods have elapsed, the remaining principal rate is calculated as (1 - R)^P.
            // Therefore, the principal due rate for these periods is computed as 1 minus the remaining principal,
            // which is 1 - (1 - R)^P.
            uint256 periodsPassedDue = calendar.getNumPeriodsPassed(
                _cc.periodDuration,
                _cr.nextDueDate,
                periodStartDate
            );
            if (principalRate > 0) {
                uint256 principalPastDue = ((HUNDRED_PERCENT_IN_BPS ** periodsPassedDue -
                    (HUNDRED_PERCENT_IN_BPS - principalRate) ** periodsPassedDue) *
                    _cr.unbilledPrincipal) / (HUNDRED_PERCENT_IN_BPS ** periodsPassedDue);
                newDD.principalPastDue += uint96(principalPastDue);
                newCR.unbilledPrincipal = uint96(_cr.unbilledPrincipal - principalPastDue);
                uint256 totalDaysInFullPeriod = calendar.getTotalDaysInFullPeriod(
                    _cc.periodDuration
                );
                principalDue =
                    (newCR.unbilledPrincipal * principalRate * daysUntilNextDue) /
                    (HUNDRED_PERCENT_IN_BPS * totalDaysInFullPeriod);
                newCR.unbilledPrincipal -= uint96(principalDue);
            }
        }
        // Recalculate both overdue and upcoming yields.
        // TODO(jiatu): do we need to account for principal past due?
        uint256 principal = _cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue;
        (, , uint256 membershipFee) = poolConfig.getFees();
        (uint256 accruedPastDue, uint256 committedPastDue) = _getYieldDue(
            _cc,
            principal,
            daysOverdue,
            membershipFee
        );
        newDD.yieldPastDue += uint96(
            accruedPastDue > committedPastDue ? accruedPastDue : committedPastDue
        );
        // Reset the recorded yield due amounts since we are in a new billing cycle now.
        (newDD.accrued, newDD.committed) = _getYieldDue(
            _cc,
            principal,
            daysUntilNextDue,
            membershipFee
        );
        newDD.paid = 0;

        //        console.log(
        //            "daysUntilNextDue: %s, principal: %s, membershipFee: %s",
        //            daysUntilNextDue,
        //            principal,
        //            membershipFee
        //        );
        newCR.yieldDue = newDD.committed > newDD.accrued ? newDD.committed : newDD.accrued;
        //        console.log("newDD.committed: %s, newDD.accrued: %s", newDD.committed, newDD.accrued);
        // Note that any non-zero existing nextDue should have been moved to pastDue already.
        // Only the newly generated nextDue needs to be recorded.
        newCR.nextDue = uint96(newCR.yieldDue + principalDue);
        newCR.totalPastDue = newDD.lateFee + newDD.yieldPastDue + newDD.principalPastDue;
        //        console.log("yield due %d, principal due %d", newCR.yieldDue, principalDue);
        //        console.log("yield past due %d, principal past due %d, late fee %d", newDD.yieldPastDue, newDD.principalPastDue, newDD.lateFee);
        //        console.log("#####################");

        return (newCR, newDD, isLate);
    }

    function getPayoffAmount(
        CreditRecord memory cr
    ) external view virtual override returns (uint256 payoffAmount) {
        return cr.unbilledPrincipal + cr.nextDue + cr.totalPastDue;
    }

    function _deepCopyCreditRecord(
        CreditRecord memory cr
    ) internal pure returns (CreditRecord memory newCR) {
        newCR.unbilledPrincipal = cr.unbilledPrincipal;
        newCR.nextDueDate = cr.nextDueDate;
        newCR.nextDue = cr.nextDue;
        newCR.yieldDue = cr.yieldDue;
        newCR.totalPastDue = cr.totalPastDue;
        newCR.missedPeriods = cr.missedPeriods;
        newCR.remainingPeriods = cr.remainingPeriods;
        newCR.state = cr.state;
        return newCR;
    }

    function _deepCopyDueDetail(
        DueDetail memory dd
    ) internal pure returns (DueDetail memory newDD) {
        newDD.lateFeeUpdatedDate = dd.lateFeeUpdatedDate;
        newDD.lateFee = dd.lateFee;
        newDD.yieldPastDue = dd.yieldPastDue;
        newDD.principalPastDue = dd.principalPastDue;
        newDD.committed = dd.committed;
        newDD.accrued = dd.accrued;
        newDD.paid = dd.paid;
        return newDD;
    }

    function _getYieldDue(
        CreditConfig memory cc,
        uint256 principal,
        uint256 daysPassed,
        uint256 membershipFee
    ) internal pure returns (uint96 accrued, uint96 committed) {
        if (daysPassed == 0) {
            return (0, 0);
        }
        accrued = uint96(
            (principal * cc.yieldInBps * daysPassed) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR) +
                membershipFee
        );
        committed = uint96(
            (cc.committedAmount * cc.yieldInBps * daysPassed) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR) +
                membershipFee
        );
        return (accrued, committed);
    }
}
