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

        // todo the computation below has slight inaccuracy. It only uses number of days, it did not
        // consider month boundary. This is a very minor issue.
        lateFee = uint96(
            _dd.lateFee +
                (lateFeeInBps *
                    (_cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue) *
                    (lateFeeUpdatedDate - _dd.lateFeeUpdatedDate)) /
                (SECONDS_IN_A_DAY * DAYS_IN_A_YEAR)
        );
        return (lateFeeUpdatedDate, lateFee);
    }

    /// @inheritdoc ICreditDueManager
    function getDueInfo(
        CreditRecord memory _cr,
        CreditConfig memory _cc,
        DueDetail memory _dd
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
        //* todo need to switch to day-boundary yield calculation
        //* todo Need to handle when the first bill starts the middle of a period.
        //* todo currently, we do not mutate the input struct param. Mutating will be more efficiency but
        // has worse readability. Let us test the mutate approach as well.
        newCR = _cr;
        newDD = _dd;

        // If the current timestamp still falls within the billing cycle, then all the amount due is up-to-date
        // except possibly the late fee. So we only need to update the late fee if it is already late.
        if (block.timestamp <= _cr.nextDueDate) {
            if (_cr.missedPeriods == 0) return (_cr, _dd, 0, false);
            else {
                (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
                return (_cr, newDD, 0, true);
            }
        }

        // Update the due date.
        uint256 newDueDate;
        (newDueDate, periodsPassed) = calendar.getNextDueDate(_cc.periodDuration, _cr.nextDueDate);
        newCR.nextDueDate = uint64(newDueDate);

        // Calculates past due and late fee
        isLate = checkLate(_cr);
        if (isLate) {
            newDD.pastDue += _cr.nextDue;
            (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(_cr, _dd);
        }

        // Calculate the yield and principal due.
        // Note that if multiple periods have passed, the yield for every period is still based on the
        // outstanding principal since there was no change to the principal
        (, , uint256 membershipFee) = poolConfig.getFees();
        uint256 principal = _cr.unbilledPrincipal + _cr.nextDue - _cr.yieldDue;

        // TODO(Richard): when multiple periods have passed, we need to account for all the yield
        // due in those periods. Currently we are only accounting for one period.
        newDD.accrued = uint96(
            (principal * _cc.yieldInBps * _cc.periodDuration) /
                (HUNDRED_PERCENT_IN_BPS * MONTHS_IN_A_YEAR) +
                membershipFee
        );
        newDD.committed = uint96(
            (_cc.committedAmount * _cc.yieldInBps * _cc.periodDuration) /
                (HUNDRED_PERCENT_IN_BPS * MONTHS_IN_A_YEAR) +
                membershipFee
        );
        uint256 yieldDue = newDD.committed > newDD.accrued ? newDD.committed : newDD.accrued;

        uint256 principalDue = 0;
        uint256 principalRate = poolConfig.getMinPrincipalRateInBps();
        if (principalRate > 0) {
            // Note that if the principalRate is R, the remaining principal rate is (1 - R).
            // When multiple periods P passed, the remaining principal rate is (1 - R)^P.
            // The incremental principal due should be 1 - (1 - R)^P.
            principalDue =
                ((HUNDRED_PERCENT_IN_BPS ** periodsPassed -
                    (HUNDRED_PERCENT_IN_BPS - principalRate) ** periodsPassed) * principal) /
                (HUNDRED_PERCENT_IN_BPS ** periodsPassed);
        }

        // Note any non-zero existing nextDue should have been moved to pastDue already.
        // Only the newly generated nextDue needs to be recorded.
        newCR.yieldDue = uint96(yieldDue);
        newCR.nextDue = uint96(yieldDue + principalDue);
        newCR.unbilledPrincipal = uint96(newCR.unbilledPrincipal - principalDue);
        newCR.totalPastDue = newDD.lateFee + newDD.pastDue;

        // If passed final period, all principal is due
        if (periodsPassed >= newCR.remainingPeriods) {
            newCR.nextDue += _cr.unbilledPrincipal;
            newCR.unbilledPrincipal = 0;
        }

        return (newCR, newDD, periodsPassed, isLate);
    }

    function getPayoffAmount(
        CreditRecord memory cr
    ) external view virtual override returns (uint256 payoffAmount) {
        return cr.unbilledPrincipal + cr.nextDue + cr.totalPastDue;
    }
}