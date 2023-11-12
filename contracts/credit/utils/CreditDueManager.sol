// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {CreditConfig, CreditRecord, CreditState, DueDetail} from "../CreditStructs.sol";
import {PoolConfig, PoolSettings} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import {DAYS_IN_A_MONTH, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, MONTHS_IN_A_YEAR, SECONDS_IN_A_DAY, SECONDS_IN_A_YEAR} from "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

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

    function checkLate(CreditRecord memory _cr) public view returns (bool) {
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
        (, uint256 lateFeeInBps, ) = poolConfig.getFees();

        lateFee = uint96(
            _dd.lateFee +
                (lateFeeInBps *
                    (_cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue) *
                    calendar.getDaysDiff(_dd.lateFeeUpdatedDate, lateFeeUpdatedDate)) /
                DAYS_IN_A_YEAR
        );
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
        returns (
            CreditRecord memory newCR,
            DueDetail memory newDD,
            uint256 periodsPassed,
            bool isLate
        )
    {
        //* todo currently, we do not mutate the input struct param. Mutating will be more efficiency but
        // has worse readability. Let us test the mutate approach as well.
        newCR = _cr;
        newDD = _dd;

        // If the current timestamp still falls within the billing cycle, then all the amount due is up-to-date
        // except possibly the late fee. So we only need to update the late fee if it is already late.
        if (block.timestamp <= _cr.nextDueDate) {
            if (_cr.missedPeriods == 0) return (_cr, _dd, 0, false);
            // TODO(jiatu): we shouldn't update the late fee if the borrower makes payment
            // within the late payment grace period.
            else {
                (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
                return (_cr, newDD, 0, true);
            }
        }

        // Update the due date.
        newCR.nextDueDate = uint64(calendar.getNextDueDate(_cc.periodDuration, maturityDate));

        // Calculates past due and late fee
        isLate = checkLate(_cr);
        if (isLate) {
            newDD.pastDue += _cr.nextDue;
            (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
        }

        // Calculate the principal due.
        uint256 principal = _cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue;
        (uint256 daysPassed, uint256 totalDaysInPeriod) = calendar.getDaysPassedInPeriod(
            _cc.periodDuration
        );
        periodsPassed = calendar.getNumPeriodsPassed(
            _cc.periodDuration,
            _cr.nextDueDate,
            block.timestamp
        );
        uint256 principalDue = 0;
        if (newCR.nextDueDate >= maturityDate) {
            // All principal is due if we are in or have passed the final period.
            // Note that it's technically impossible for the > to be true, but we are using >=
            // just to be safe.
            principalDue = _cr.unbilledPrincipal;
        } else {
            uint256 principalRate = poolConfig.getMinPrincipalRateInBps();
            if (principalRate > 0) {
                if (_cr.nextDueDate == 0) {
                    // This is the first drawdown and the due info has never been updated.
                    // Given that the billing period may start mid-period and `principalRate` is for whole periods,
                    // we must calculate a prorated amount for the initial period based on the actual days.
                    // For instance, if the `principalRate` is 3% for a full period, and the principal is
                    // $1,000 with only 20 out of 30 days in the first billing cycle, then the prorated principal due
                    // is $1,000 * 3% * (20/30), which equals $20.
                    // In this case, `daysPassed` here is the days passed in the first period, which will be used to
                    // calculate the remaining days in the first period.
                    principalDue =
                        (principal * principalRate * (totalDaysInPeriod - daysPassed)) /
                        totalDaysInPeriod;
                } else {
                    // For subsequent drawdowns, apply the full principal rate over the entire periods that have passed.
                    // There's no need to prorate the last partial period, as this scenario is separately accounted for
                    // in the case where `nextDueDate` is on or after the `maturityDate`.
                    // Assuming the `principalRate` is represented by R, the remaining principal after one period is (1 - R).
                    // When P full periods have elapsed, the remaining principal is calculated as (1 - R)^P.
                    // Therefore, the principal due for these periods is computed as 1 minus the remaining principal,
                    // which is 1 - (1 - R)^P.
                    principalDue =
                        ((HUNDRED_PERCENT_IN_BPS ** periodsPassed -
                            (HUNDRED_PERCENT_IN_BPS - principalRate) ** periodsPassed) *
                            principal) /
                        (HUNDRED_PERCENT_IN_BPS ** periodsPassed);
                }
            }
        }
        newCR.unbilledPrincipal = uint96(_cr.unbilledPrincipal - principalDue);

        // Calculate the yield due. Note that if multiple periods have passed, the yield for every period is still
        // based on the outstanding principal since there was no change to the principal
        (, , uint256 membershipFee) = poolConfig.getFees();
        daysPassed = calendar.getDaysDiff(_cr.nextDueDate, newCR.nextDueDate);
        newDD.accrued = uint96(
            (principal * _cc.yieldInBps * totalDaysInPeriod) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR) +
                membershipFee
        );
        newDD.committed = uint96(
            (_cc.committedAmount * _cc.yieldInBps * totalDaysInPeriod) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR) +
                membershipFee
        );
        newCR.yieldDue = uint96(
            ((newDD.committed > newDD.accrued ? newDD.committed : newDD.accrued) * daysPassed) /
                totalDaysInPeriod
        );
        newCR.nextDue = uint96(newCR.yieldDue + principalDue);

        // Note any non-zero existing nextDue should have been moved to pastDue already.
        // Only the newly generated nextDue needs to be recorded.
        newCR.totalPastDue = newDD.lateFee + newDD.pastDue;

        return (newCR, newDD, periodsPassed, isLate);
    }

    function getPayoffAmount(
        CreditRecord memory cr
    ) external view virtual override returns (uint256 payoffAmount) {
        return cr.unbilledPrincipal + cr.nextDue + cr.totalPastDue;
    }
}
