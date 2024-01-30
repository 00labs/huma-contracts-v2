// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {CreditConfig, CreditRecord, CreditState, DueDetail, PayPeriodDuration} from "./CreditStructs.sol";
import {PoolConfig, PoolSettings, FeeStructure} from "../common/PoolConfig.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS, SECONDS_IN_A_DAY} from "../common/SharedDefs.sol";
import {Errors} from "../common/Errors.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";

contract CreditDueManager is PoolConfigCache, ICreditDueManager {
    ICalendar public calendar;

    /// @inheritdoc ICreditDueManager
    function distBorrowingAmount(
        uint256 borrowAmount
    ) external view virtual returns (uint256 amtToBorrower, uint256 platformFees) {
        // Calculate platform fee, which includes protocol fee and pool fee
        platformFees = calcFrontLoadingFee(borrowAmount);
        if (borrowAmount < platformFees) revert Errors.BorrowAmountLessThanPlatformFees();
        amtToBorrower = borrowAmount - platformFees;
        return (amtToBorrower, platformFees);
    }

    /// @inheritdoc ICreditDueManager
    function getDueInfo(
        CreditRecord memory cr,
        CreditConfig memory cc,
        DueDetail memory dd,
        uint256 timestamp
    ) external view virtual override returns (CreditRecord memory newCR, DueDetail memory newDD) {
        // Do not update due info for credits that are under certain states, such as closed and defaulted.
        if (
            cr.state != CreditState.Approved &&
            cr.state != CreditState.GoodStanding &&
            cr.state != CreditState.Delayed
        ) return (cr, dd);
        // If the credit is approved, then a non-zero `cr.nextDueDate` represents the designated credit start date.
        // In this case, the bill should be returned as-is since it hasn't started yet.
        if (cr.state == CreditState.Approved && timestamp < cr.nextDueDate) return (cr, dd);

        bool shouldAdvanceToNextPeriod = false;
        bool isLate = false;

        {
            uint256 nextBillRefreshDate = getNextBillRefreshDate(cr);
            if (cr.state == CreditState.Approved || timestamp > nextBillRefreshDate) {
                shouldAdvanceToNextPeriod = true;
            }
            if (
                cr.state == CreditState.Delayed ||
                // The last due was not paid off
                (cr.state == CreditState.GoodStanding &&
                    cr.nextDue > 0 &&
                    timestamp > nextBillRefreshDate) ||
                // The last due was paid off, but next due wasn't refreshed
                (cr.state == CreditState.GoodStanding &&
                    cr.nextDue == 0 &&
                    cr.unbilledPrincipal > 0 &&
                    timestamp >
                    calendar.getStartDateOfNextPeriod(cc.periodDuration, cr.nextDueDate)) ||
                // Outstanding commitment
                (cr.state == CreditState.GoodStanding &&
                    cr.nextDue + cr.unbilledPrincipal == 0 &&
                    cc.committedAmount > 0 &&
                    cr.remainingPeriods > 0 &&
                    timestamp >
                    calendar.getStartDateOfNextPeriod(cc.periodDuration, cr.nextDueDate))
            ) {
                isLate = true;
            }
        }

        if (!shouldAdvanceToNextPeriod && !isLate) return (cr, dd);

        newCR = _deepCopyCreditRecord(cr);
        newDD = _deepCopyDueDetail(dd);
        if (cr.state == CreditState.Approved) newCR.state = CreditState.GoodStanding;
        // Update periods passed and remaining periods.
        uint256 periodsPassed = 0;
        if (cr.state != CreditState.Approved && timestamp > cr.nextDueDate) {
            // If the credit is just approved, then updating `remainingPeriods` will be taken care of when next due
            // is calculated below. Hence we don't need to update it here.
            // Otherwise, compute the number of periods passed since the last due date until the beginning of the
            // period that `timestamp` is in.
            uint256 startDateOfCurrentPeriod = calendar.getStartDateOfPeriod(
                cc.periodDuration,
                timestamp
            );
            periodsPassed = calendar.getNumPeriodsPassed(
                cc.periodDuration,
                cr.nextDueDate,
                startDateOfCurrentPeriod
            );
            if (cr.remainingPeriods > 0) {
                // Update the number of remaining periods by subtracting the number of periods passed.
                // Note that `periodsPassed` can be greater than `remainingPeriods` since the bill could
                // have gone past the maturity date.
                newCR.remainingPeriods = cr.remainingPeriods > uint16(periodsPassed)
                    ? cr.remainingPeriods - uint16(periodsPassed)
                    : 0;
            }
        }

        uint256 principalRate = 0;
        {
            FeeStructure memory fees = poolConfig.getFeeStructure();
            principalRate = fees.minPrincipalRateInBps;
        }
        uint256 totalDaysInFullPeriod = calendar.getTotalDaysInFullPeriod(cc.periodDuration);

        if (isLate) {
            if (timestamp > cr.nextDueDate) {
                // Update the number of periods that the bill has missed if the bill is late. First note that
                // `periodsPassed` does not include the period that `cr` was in, since it's the number of periods
                // passed between `cr.nextDueDate` and the beginning of the period `timestamp` is in.
                // With that in mind, there are two cases to consider:
                // 1. If all the amount due has been paid off on the bill represented by `cr`, then the period that `cr`
                //    was in should not be counted as a missed period. This is the `true` part of the ternary below.
                // 2. Otherwise, since there was unpaid due, the period `cr` was in should be counted as a missed
                //    period, hence the +1 in the `false` part of the ternary below.
                newCR.missedPeriods += uint16(
                    cr.nextDue + cr.totalPastDue == 0 &&
                        (cr.unbilledPrincipal > 0 || cc.committedAmount > 0)
                        ? periodsPassed // last due was paid off
                        : periodsPassed + 1 // last due was not paid off
                );

                // Move the previous next due on `cr` to past due first.
                newDD.yieldPastDue += cr.yieldDue;
                newDD.principalPastDue += cr.nextDue - cr.yieldDue;

                if (periodsPassed > 0) {
                    // If the number of periods passed is non-zero, then we need to compute the additional yield and
                    // principal past due for the periods that were "skipped". For example, suppose the bill has
                    // monthly pay period, `cr.nextDueDate` is Feb 1, and `timestamp` is May 15, then March and April
                    // were "skipped", and we need to compute the yield and principal due that were supposed to happen
                    // in those two months and add the amounts to past due.
                    newDD.yieldPastDue += uint96(
                        _computeYieldNextDue(
                            cc.yieldInBps,
                            cr.unbilledPrincipal + cr.nextDue - cr.yieldDue + dd.principalPastDue,
                            cc.committedAmount,
                            periodsPassed * totalDaysInFullPeriod
                        )
                    );

                    if (cr.unbilledPrincipal > 0) {
                        if (principalRate > 0) {
                            uint256 principalPastDue = _computePrincipalDueForFullPeriods(
                                cr.unbilledPrincipal,
                                principalRate,
                                periodsPassed
                            );
                            newDD.principalPastDue += uint96(principalPastDue);
                            newCR.unbilledPrincipal = uint96(
                                cr.unbilledPrincipal - principalPastDue
                            );
                        }

                        if (newCR.remainingPeriods == 0) {
                            // If `remainingPeriods` is 0, then the bill has gone past the maturity date, and all
                            // principal is past due.
                            newDD.principalPastDue += newCR.unbilledPrincipal;
                            newCR.unbilledPrincipal = 0;
                        }
                    }
                }
            }

            // Refreshes the late fee up to the end of the day that `timestamp` is in.
            (newDD.lateFeeUpdatedDate, newDD.lateFee) = refreshLateFee(
                cr,
                dd,
                cc.periodDuration,
                cc.committedAmount,
                timestamp
            );

            newCR.totalPastDue = newDD.lateFee + newDD.yieldPastDue + newDD.principalPastDue;
            newCR.state = CreditState.Delayed;
        }

        if (shouldAdvanceToNextPeriod) {
            // Advance the next due date to the beginning of the next period.
            newCR.nextDueDate = uint64(
                calendar.getStartDateOfNextPeriod(cc.periodDuration, timestamp)
            );
            // Set `paid` to 0 since we are starting a new period.
            newDD.paid = 0;

            uint256 daysUntilNextDue;
            if (cr.state == CreditState.Approved) {
                // If the credit is just approved, then we are in the first period, which may be a partial period.
                // Hence we need to count the number of days from now until the start of the next period.
                daysUntilNextDue = calendar.getDaysDiff(timestamp, newCR.nextDueDate);
            } else {
                // All other periods are full periods.
                daysUntilNextDue = totalDaysInFullPeriod;
            }

            // Computes yield due. Note that there is yield due as long as there is unpaid principal, even if the bill
            // has gone past maturity.
            uint256 totalPrincipal = cr.unbilledPrincipal +
                cr.nextDue -
                cr.yieldDue +
                dd.principalPastDue;
            (newDD.accrued, newDD.committed) = _computeAccruedAndCommittedYieldDue(
                cc.yieldInBps,
                totalPrincipal,
                cc.committedAmount,
                daysUntilNextDue
            );
            // Yield due is the larger of the accrued and committed amount.
            newCR.yieldDue = newDD.committed > newDD.accrued ? newDD.committed : newDD.accrued;
            newCR.nextDue = newCR.yieldDue;

            if (newCR.remainingPeriods > 0) {
                // Subtract the current period from `remainingPeriods`.
                newCR.remainingPeriods -= 1;

                if (newCR.unbilledPrincipal > 0) {
                    if (principalRate > 0) {
                        uint256 principalDue = _computePrincipalDueForPartialPeriod(
                            newCR.unbilledPrincipal,
                            principalRate,
                            daysUntilNextDue,
                            totalDaysInFullPeriod
                        );
                        newCR.unbilledPrincipal -= uint96(principalDue);
                        newCR.nextDue += uint96(principalDue);
                    }

                    if (newCR.remainingPeriods == 0) {
                        // If we are in the final period, then all principal is due.
                        newCR.nextDue += newCR.unbilledPrincipal;
                        newCR.unbilledPrincipal = 0;
                    }
                }
            }
        }

        return (newCR, newDD);
    }

    function getPayoffAmount(
        CreditRecord memory cr
    ) external view virtual override returns (uint256 payoffAmount) {
        return cr.unbilledPrincipal + cr.nextDue + cr.totalPastDue;
    }

    /// @inheritdoc ICreditDueManager
    function computeAdditionalYieldAccruedAndPrincipalDueForDrawdown(
        PayPeriodDuration periodDuration,
        uint256 borrowAmount,
        uint256 nextDueDate,
        uint256 yieldInBps
    ) external view returns (uint256 additionalYieldAccrued, uint256 additionalPrincipalDue) {
        uint256 daysRemaining = calendar.getDaysRemainingInPeriod(nextDueDate);
        // It's important to note that the yield calculation includes the day of the drawdown. For instance,
        // if the borrower draws down at 11:59 PM on October 30th, the yield for October 30th must be paid.
        additionalYieldAccrued = _computeYieldDue(borrowAmount, yieldInBps, daysRemaining);
        FeeStructure memory fees = poolConfig.getFeeStructure();
        if (fees.minPrincipalRateInBps > 0) {
            additionalPrincipalDue = _computePrincipalDueForPartialPeriod(
                borrowAmount,
                fees.minPrincipalRateInBps,
                daysRemaining,
                calendar.getTotalDaysInFullPeriod(periodDuration)
            );
        }
        return (additionalYieldAccrued, additionalPrincipalDue);
    }

    /// @inheritdoc ICreditDueManager
    function recomputeYieldDue(
        uint256 nextDueDate,
        uint256 oldYieldDue,
        uint256 oldYieldInBps,
        uint256 newYieldInBps,
        uint256 principal
    ) external view returns (uint256 updatedYield) {
        uint256 daysRemaining = calendar.getDaysRemainingInPeriod(nextDueDate);
        // Note that we do not divide by `(HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR)` here since division rounds down.
        // We will do summation before division at the end for better precision.
        uint256 newYieldDueForDaysRemaining = principal * newYieldInBps * (daysRemaining - 1);
        uint256 oldYieldDueForDaysRemaining = principal * oldYieldInBps * (daysRemaining - 1);
        return
            (oldYieldDue *
                HUNDRED_PERCENT_IN_BPS *
                DAYS_IN_A_YEAR +
                newYieldDueForDaysRemaining -
                oldYieldDueForDaysRemaining) / (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR);
    }

    /// @inheritdoc ICreditDueManager
    function recomputeCommittedYieldDueAfterCommitmentChange(
        uint256 nextDueDate,
        uint256 oldCommittedYieldDue,
        uint256 oldCommittedAmount,
        uint256 newCommittedAmount,
        uint256 yieldInBps
    ) external view returns (uint256 updatedYield) {
        uint256 daysRemaining = calendar.getDaysRemainingInPeriod(nextDueDate);
        uint256 newYieldDueForDaysRemaining = newCommittedAmount *
            yieldInBps *
            (daysRemaining - 1);
        uint256 oldYieldDueForDaysRemaining = oldCommittedAmount *
            yieldInBps *
            (daysRemaining - 1);
        return
            (oldCommittedYieldDue *
                HUNDRED_PERCENT_IN_BPS *
                DAYS_IN_A_YEAR +
                newYieldDueForDaysRemaining -
                oldYieldDueForDaysRemaining) / (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR);
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

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);
    }

    function _computePrincipalDueForFullPeriods(
        uint256 unbilledPrincipal,
        uint256 principalRateInBps,
        uint256 numPeriods
    ) internal pure returns (uint256 principalDue) {
        return
            ((HUNDRED_PERCENT_IN_BPS ** numPeriods -
                (HUNDRED_PERCENT_IN_BPS - principalRateInBps) ** numPeriods) * unbilledPrincipal) /
            (HUNDRED_PERCENT_IN_BPS ** numPeriods);
    }

    function _computePrincipalDueForPartialPeriod(
        uint256 unbilledPrincipal,
        uint256 principalRateInBps,
        uint256 numDays,
        uint256 totalDaysInFullPeriod
    ) internal pure returns (uint256 principalDue) {
        return
            (unbilledPrincipal * principalRateInBps * numDays) /
            (HUNDRED_PERCENT_IN_BPS * totalDaysInFullPeriod);
    }

    function _computeYieldNextDue(
        uint256 yieldInBps,
        uint256 principal,
        uint256 committedAmount,
        uint256 daysPassed
    ) internal pure returns (uint256 maxYieldDue) {
        uint256 accrued = _computeYieldDue(principal, yieldInBps, daysPassed);
        uint256 committed = _computeYieldDue(committedAmount, yieldInBps, daysPassed);
        return accrued > committed ? accrued : committed;
    }

    function _computeAccruedAndCommittedYieldDue(
        uint256 yieldInBps,
        uint256 principal,
        uint256 committedAmount,
        uint256 daysPassed
    ) internal pure returns (uint96 accrued, uint96 committed) {
        accrued = _computeYieldDue(principal, yieldInBps, daysPassed);
        committed = _computeYieldDue(committedAmount, yieldInBps, daysPassed);
        return (accrued, committed);
    }

    function _computeYieldDue(
        uint256 principal,
        uint256 yieldInBps,
        uint256 numDays
    ) internal pure returns (uint96 yieldDue) {
        return
            uint96((principal * yieldInBps * numDays) / (HUNDRED_PERCENT_IN_BPS * DAYS_IN_A_YEAR));
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
}
