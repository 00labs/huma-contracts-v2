// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {CreditConfig, CreditRecord, CreditState, DueDetail, PayPeriodDuration} from "../CreditStructs.sol";
import {PoolConfig, PoolSettings, FeeStructure} from "../../PoolConfig.sol";
import {ICalendar} from "../interfaces/ICalendar.sol";
import {DAYS_IN_A_MONTH, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, MONTHS_IN_A_YEAR, SECONDS_IN_A_DAY, SECONDS_IN_A_YEAR} from "../../SharedDefs.sol";
import {Errors} from "../../Errors.sol";
import {PoolConfigCache} from "../../PoolConfigCache.sol";

import "hardhat/console.sol";

contract CreditDueManager is PoolConfigCache, ICreditDueManager {
    ICalendar public calendar;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        assert(addr != address(0));
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

    function checkIsLate(
        CreditRecord memory cr,
        uint256 timestamp
    ) public view returns (bool isLate) {
        if (cr.missedPeriods > 0) return true;

        return cr.nextDue != 0 && timestamp > getNextBillRefreshDate(cr);
    }

    function getNextBillRefreshDate(
        CreditRecord memory cr
    ) public view returns (uint256 refreshDate) {
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        uint256 latePaymentDeadline = cr.nextDueDate +
            poolSettings.latePaymentGracePeriodInDays *
            SECONDS_IN_A_DAY;
        if (cr.state == CreditState.GoodStanding && cr.nextDue != 0) {
            // If this is the first time ever that the bill has surpassed the due date and the bill has unpaid amounts,
            // then we don't want to refresh the bill since we want the user to focus on paying off the current due.
            return latePaymentDeadline;
        }
        return cr.nextDueDate;
    }

    function refreshLateFee(
        CreditRecord memory _cr,
        DueDetail memory _dd,
        PayPeriodDuration periodDuration,
        uint256 committedAmount,
        uint256 timestamp
    ) public view override returns (uint64 lateFeeUpdatedDate, uint96 lateFee) {
        lateFeeUpdatedDate = uint64(calendar.getStartOfNextDay(timestamp));
        FeeStructure memory fees = poolConfig.getFeeStructure();
        // If the credit state is good-standing, then the bill is late for the first time.
        // We need to charge the late fee from the last due date onwards.
        uint256 lateFeeStartDate;
        if (_cr.state == CreditState.GoodStanding) {
            if (_cr.nextDue == 0) {
                // If the amount due has been paid off in the current billing cycle,
                // then the late fee should be charged from the due date of the next billing cycle onwards
                // since the next billing cycle is the first cycle that's late.
                lateFeeStartDate = calendar.getStartDateOfNextPeriod(
                    periodDuration,
                    _cr.nextDueDate
                );
            } else {
                lateFeeStartDate = _cr.nextDueDate;
            }
        } else {
            lateFeeStartDate = _dd.lateFeeUpdatedDate;
        }

        // TODO(jiatu): gas-golf dd reading. Is this easy to do?
        // Use the larger of the outstanding principal and the committed amount as the basis for calculating
        // the late fee. While this is not 100% accurate since the relative magnitude of the two value
        // may change between the last time late fee was refreshed and now, we are intentionally making this
        // simplification since in reality the principal will almost always be higher the committed amount.
        uint256 totalPrincipal = _cr.unbilledPrincipal +
            _cr.nextDue -
            _cr.yieldDue +
            _dd.principalPastDue;
        uint256 lateFeeBasis = totalPrincipal > committedAmount ? totalPrincipal : committedAmount;
        lateFee = uint96(
            _dd.lateFee +
                (fees.lateFeeBps *
                    lateFeeBasis *
                    calendar.getDaysDiff(lateFeeStartDate, lateFeeUpdatedDate)) /
                (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR)
        );
        return (lateFeeUpdatedDate, lateFee);
    }

    /// @inheritdoc ICreditDueManager
    function getDueInfo(
        CreditRecord memory cr,
        CreditConfig memory cc,
        DueDetail memory dd,
        uint256 timestamp
    ) public view virtual override returns (CreditRecord memory newCR, DueDetail memory newDD) {
        // Do not update due info for accounts already in default state.
        if (cr.state == CreditState.Defaulted) return (cr, dd);

        newCR = _deepCopyCreditRecord(cr);
        newDD = _deepCopyDueDetail(dd);

        bool isFirstPeriod = cr.state == CreditState.Approved;
        // If the current timestamp has not yet reached the bill refresh date, then all the amount due is up-to-date
        // except possibly the late fee. So we only need to update the late fee if it is already late.
        if (!isFirstPeriod && timestamp <= getNextBillRefreshDate(cr)) {
            if (cr.missedPeriods == 0) return (newCR, newDD);
            else {
                newCR.totalPastDue -= dd.lateFee;
                (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(
                    cr,
                    dd,
                    cc.periodDuration,
                    cc.committedAmount,
                    timestamp
                );
                newCR.totalPastDue += newDD.lateFee;
                return (newCR, newDD);
            }
        }

        // Update the due date.
        newCR.nextDueDate = uint64(
            calendar.getStartDateOfNextPeriod(cc.periodDuration, timestamp)
        );

        // At this point, the bill has gone past the refresh date. Any unpaid next due is now overdue.
        if (cr.nextDue > 0) {
            newDD.yieldPastDue += cr.yieldDue;
            newDD.principalPastDue += cr.nextDue - cr.yieldDue;
        }

        uint256 principalDue;
        if (cr.remainingPeriods != 0) {
            uint256 totalPrincipal = cr.unbilledPrincipal +
                cr.nextDue -
                cr.yieldDue +
                dd.principalPastDue;
            uint256 maturityDate = calendar.getMaturityDate(
                cc.periodDuration,
                cr.remainingPeriods,
                isFirstPeriod ? timestamp : cr.nextDueDate
            );

            // Compute amounts overdue. Note that there is no past due if this is the first period of the credit.
            if (!isFirstPeriod) {
                (
                    uint256 accruedYieldPastDue,
                    uint256 committedYieldPastDue,
                    uint256 principalPastDue
                ) = _computePastDue(cc, cr, totalPrincipal, timestamp, maturityDate);
                newDD.yieldPastDue += uint96(
                    accruedYieldPastDue > committedYieldPastDue
                        ? accruedYieldPastDue
                        : committedYieldPastDue
                );
                newDD.principalPastDue += uint96(principalPastDue);
                newCR.unbilledPrincipal = uint96(cr.unbilledPrincipal - principalPastDue);
            }

            // Compute next due. There is only next due if the bill has not gone past the maturity date yet.
            (newDD.accrued, newDD.committed, principalDue) = _computeNextDue(
                cc,
                newCR,
                totalPrincipal,
                timestamp,
                newCR.nextDueDate,
                maturityDate,
                isFirstPeriod
            );
            newCR.unbilledPrincipal -= uint96(principalDue);
        } else {
            newDD.principalPastDue += cr.unbilledPrincipal;
            newDD.accrued = 0;
            newDD.committed = 0;
            newCR.unbilledPrincipal = 0;
        }

        newDD.paid = 0;
        newCR.yieldDue = newDD.committed > newDD.accrued ? newDD.committed : newDD.accrued;
        // Note that any non-zero existing next due should have been moved to past due already.
        // Only the newly generated next due needs to be recorded.
        newCR.nextDue = uint96(newCR.yieldDue + principalDue);

        // +1 to account for the first period:
        // 1. If this is the first period, 1 represents the first partial period.
        // 2. Otherwise, since we start counting the number of periods passed with `cr.nextDueDate`
        //    as the start date, 1 represents the period that ends on `cr.nextDueDate`.
        uint256 periodsPassed = 1 +
            calendar.getNumPeriodsPassed(
                cc.periodDuration,
                isFirstPeriod ? timestamp : cr.nextDueDate,
                timestamp
            );
        // Adjusts remainingPeriods. Sets remainingPeriods to 0 if the credit line has reached maturity.
        newCR.remainingPeriods = cr.remainingPeriods > periodsPassed
            ? uint16(cr.remainingPeriods - periodsPassed)
            : 0;

        if (newDD.yieldPastDue > 0 || newDD.principalPastDue > 0) {
            // Make sure the late fee is up-to-date if there is past due.
            (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(
                cr,
                dd,
                cc.periodDuration,
                cc.committedAmount,
                timestamp
            );
            if (cr.state == CreditState.GoodStanding && cr.nextDue == 0) {
                // If the amount due is paid off in the previous billing cycle, then that billing cycle
                // is not missed even if the bill is late now, hence the -1.
                newCR.missedPeriods = uint16(cr.missedPeriods + periodsPassed - 1);
            } else {
                newCR.missedPeriods = uint16(cr.missedPeriods + periodsPassed);
            }
            newCR.state = CreditState.Delayed;
        } else {
            newCR.missedPeriods = 0;
            newCR.state = CreditState.GoodStanding;
        }
        newCR.totalPastDue = newDD.lateFee + newDD.yieldPastDue + newDD.principalPastDue;

        return (newCR, newDD);
    }

    function getPayoffAmount(
        CreditRecord memory cr
    ) external view virtual override returns (uint256 payoffAmount) {
        return cr.unbilledPrincipal + cr.nextDue + cr.totalPastDue;
    }

    function computeAccruedAndCommittedYieldDue(
        CreditConfig memory cc,
        uint256 principal,
        uint256 daysPassed
    ) internal pure returns (uint96 accrued, uint96 committed) {
        accrued = computeYieldDue(principal, cc.yieldInBps, daysPassed);
        committed = computeYieldDue(cc.committedAmount, cc.yieldInBps, daysPassed);
        return (accrued, committed);
    }

    function computeYieldDue(
        uint256 principal,
        uint256 yieldInBps,
        uint256 numDays
    ) public pure returns (uint96 yieldDue) {
        return
            uint96((principal * yieldInBps * numDays) / (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR));
    }

    /// @inheritdoc ICreditDueManager
    function computeUpdatedYieldDue(
        uint256 nextDueDate,
        uint256 oldYield,
        uint256 oldValue,
        uint256 newValue,
        uint256 principal
    ) public view returns (uint256 updatedYield) {
        uint256 daysRemaining = calendar.getDaysRemainingInPeriod(nextDueDate);
        // Since the new value may be smaller than the old value, we need to work with signed integers.
        int256 valueDiff = int256(newValue) - int256(oldValue);
        // -1 since the new value takes effect the next day.
        int256 yieldDiff = (int256((daysRemaining - 1) * principal) * valueDiff);
        return
            uint256(int256(oldYield * HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR) + yieldDiff) /
            (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR);
    }

    function computePrincipalDueForFullPeriods(
        uint256 unbilledPrincipal,
        uint256 principalRateInBps,
        uint256 numPeriods
    ) public pure returns (uint256 principalDue) {
        return
            ((HUNDRED_PERCENT_IN_BPS ** numPeriods -
                (HUNDRED_PERCENT_IN_BPS - principalRateInBps) ** numPeriods) * unbilledPrincipal) /
            (HUNDRED_PERCENT_IN_BPS ** numPeriods);
    }

    /// @inheritdoc ICreditDueManager
    function computePrincipalDueForPartialPeriod(
        uint256 unbilledPrincipal,
        uint256 principalRateInBps,
        uint256 numDays,
        PayPeriodDuration periodDuration
    ) public view returns (uint256 principalDue) {
        uint256 totalDaysInFullPeriod = calendar.getTotalDaysInFullPeriod(periodDuration);
        return
            (unbilledPrincipal * principalRateInBps * numDays) /
            (HUNDRED_PERCENT_IN_BPS * totalDaysInFullPeriod);
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

    function _computePastDue(
        CreditConfig memory cc,
        CreditRecord memory cr,
        uint256 totalPrincipal,
        uint256 timestamp,
        uint256 maturityDate
    )
        internal
        view
        returns (uint256 accruedYieldDue, uint256 committedYieldDue, uint256 principalDue)
    {
        uint256 periodStartDate = calendar.getStartDateOfPeriod(cc.periodDuration, timestamp);
        // Since the bill could have gone past the maturity date for many periods, we need to make sure
        // that the amount overdue is only calculated up until the maturity date.
        periodStartDate = periodStartDate > maturityDate ? maturityDate : periodStartDate;
        assert(cr.nextDueDate <= periodStartDate);
        if (cr.nextDueDate == periodStartDate) {
            // In this scenario, the timestamp is one period after the previous billing cycle, so there is
            // no additional yield or principal overdue.
            return (0, 0, 0);
        }

        uint256 daysOverdue = calendar.getDaysDiff(cr.nextDueDate, periodStartDate);
        (accruedYieldDue, committedYieldDue) = computeAccruedAndCommittedYieldDue(
            cc,
            totalPrincipal,
            daysOverdue
        );

        if (timestamp <= maturityDate) {
            FeeStructure memory fees = poolConfig.getFeeStructure();
            uint256 principalRate = fees.minPrincipalRateInBps;
            if (principalRate > 0) {
                uint256 periodsOverdue = calendar.getNumPeriodsPassed(
                    cc.periodDuration,
                    cr.nextDueDate,
                    periodStartDate
                );
                principalDue = computePrincipalDueForFullPeriods(
                    cr.unbilledPrincipal,
                    principalRate,
                    periodsOverdue
                );
            }
        } else {
            // All principal is overdue if the bill has gone past the maturity date.
            principalDue = cr.unbilledPrincipal;
        }
        return (accruedYieldDue, committedYieldDue, principalDue);
    }

    function _computeNextDue(
        CreditConfig memory cc,
        CreditRecord memory cr,
        uint256 totalPrincipal,
        uint256 timestamp,
        uint256 nextDueDate,
        uint256 maturityDate,
        bool isFirstPeriod
    )
        internal
        view
        returns (uint96 accruedYieldDue, uint96 committedYieldDue, uint256 principalDue)
    {
        if (timestamp > maturityDate) {
            // Everything is overdue if the timestamp has gone past the maturity date, hence there is no next due.
            return (0, 0, 0);
        }

        uint256 daysUntilNextDue;
        if (isFirstPeriod) {
            daysUntilNextDue = calendar.getDaysDiff(timestamp, cr.nextDueDate);
        } else {
            uint256 periodStartDate = calendar.getStartDateOfPeriod(cc.periodDuration, timestamp);
            daysUntilNextDue = calendar.getDaysDiff(periodStartDate, cr.nextDueDate);
        }
        (accruedYieldDue, committedYieldDue) = computeAccruedAndCommittedYieldDue(
            cc,
            totalPrincipal,
            daysUntilNextDue
        );
        FeeStructure memory fees = poolConfig.getFeeStructure();
        if (nextDueDate == maturityDate) {
            // All principal is due in the last billing cycle.
            principalDue = cr.unbilledPrincipal;
        } else if (fees.minPrincipalRateInBps > 0) {
            principalDue = computePrincipalDueForPartialPeriod(
                cr.unbilledPrincipal,
                fees.minPrincipalRateInBps,
                daysUntilNextDue,
                cc.periodDuration
            );
        }
        return (accruedYieldDue, committedYieldDue, principalDue);
    }
}
