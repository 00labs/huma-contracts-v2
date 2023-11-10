// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DAYS_IN_A_MONTH, DAYS_IN_A_QUARTER, DAYS_IN_A_HALF_YEAR} from "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";
import {PayPeriodDuration} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

//* todo change periodDuration to an enum {Monthly, Quarterly, SemiAnnually}
/**
 * @notice We use the 30/360 day count convention in this implementation, which treats every month as having 30 days
 * and every year as having 360 days, regardless of the actual number of days in a month/year. This is a common
 * practice in corporate finance.
 */
contract Calendar is ICalendar {
    /// @inheritdoc ICalendar
    function getStartOfNextMonth() external view returns (uint256 startOfNextMonth) {
        return _getStartOfNextMonth(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfNextQuarter() external view returns (uint256 startOfNextQuarter) {
        return _getStartOfNextQuarter(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfNextHalfYear() external view returns (uint256 startOfNextHalfYear) {
        return _getStartOfNextHalfYear(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfTomorrow() external view returns (uint256 startOfTomorrow) {
        return DTL.addDays(getStartOfToday(), 1);
    }

    /// @inheritdoc ICalendar
    function getStartOfThisMonth() public view returns (uint256 startOfMonth) {
        return _getStartOfMonth(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfThisQuarter() public view returns (uint256 startOfQuarter) {
        return _getStartOfQuarter(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfThisHalfYear() public view returns (uint256 startOfHalfYear) {
        return _getStartOfHalfYear(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getStartOfToday() public view returns (uint256 startOfToday) {
        (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
        startOfToday = DTL.timestampFromDate(year, month, day);
        return startOfToday;
    }

    /// @inheritdoc ICalendar
    function getDaysPassedInPeriod(
        uint256 periodDuration
    ) external view returns (uint256 daysPassed, uint256 totalDaysInPeriod) {
        (, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
        month = (month - 1) % periodDuration;
        daysPassed = month * DAYS_IN_A_MONTH + day;
        totalDaysInPeriod = periodDuration * DAYS_IN_A_MONTH;
        return (daysPassed, totalDaysInPeriod);
    }

    function getDaysPassedInPeriod(
        PayPeriodDuration periodDuration
    ) public view returns (uint256 daysPassed, uint256 totalDaysInPeriod) {
        uint256 day = DTL.getDay(block.timestamp);
        // If the day falls on the 31st, move it back to the 30th.
        day = day > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : day;
        uint256 startOfPeriod = _getStartDateOfPeriod(periodDuration, block.timestamp);
        uint256 numMonthsPassed = DTL.diffMonths(startOfPeriod, block.timestamp);
        // -1 here since we are using the beginning of the day.
        daysPassed = numMonthsPassed * DAYS_IN_A_MONTH + day - 1;
        return (daysPassed, _getTotalDaysInPeriod(periodDuration));
    }

    /// @inheritdoc ICalendar
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) public pure returns (uint256 daysDiff) {
        if (startDate > endDate) {
            revert Errors.startDateLaterThanEndDate();
        }

        (, uint256 startMonth, uint256 startDay) = DTL.timestampToDate(startDate);
        (, uint256 endMonth, uint256 endDay) = DTL.timestampToDate(endDate);
        startDay = startDay > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : startDay;
        endDay = endDay > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : endDay;
        if (startMonth == endMonth) {
            return endDay - startDay;
        }

        uint256 numMonthsPassed = DTL.diffMonths(startDate, endDate);
        // The final result is given by the sum of the following three components:
        // 1. The number of days between the start date and the end of the start month.
        // 2. The number of days in whole months passed.
        // 3. The number of days between the start of the end month and the end date.
        return DAYS_IN_A_MONTH - startDay + (numMonthsPassed - 1) * DAYS_IN_A_MONTH + endDay;
    }

    /// @inheritdoc ICalendar
    function getStartDateOfPeriod(
        uint256 periodDuration,
        uint256 periodEndDate
    ) external pure returns (uint256 startDate) {
        //* todo This implementation is not right. For quarterly, periodDuration=3,
        // if it is 2/1/xxxx, startDateOfPeriod should be 1/1/xxxx, instead of
        // going back 3 months. Need to check if we really this function and fix.
        return DTL.subMonths(periodEndDate, periodDuration);
    }

    /// @inheritdoc ICalendar
    function getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfNextPeriod) {
        if (timestamp == 0) {
            timestamp = block.timestamp;
        }
        return _getStartDateOfNextPeriod(periodDuration, timestamp);
    }

    /// @inheritdoc ICalendar
    function getNextDueDate(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        //* todo only need to support monthly, quarterly, and semi-annually. If the loan starts
        // in the middle of a quarter, its next due is the beginning of the next quarter (Jan, Apr, Jul, or Oct)
        // The final period will not be a full quarter. The due date will be the maturity date.
        // Because of this logic, the API to get the next due date should be refined.

        uint256 monthCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, 1);
            monthCount = 1;
        } else {
            numberOfPeriodsPassed = DTL.diffMonths(lastDueDate, block.timestamp) / periodDuration;
        }
        monthCount += (numberOfPeriodsPassed + 1) * periodDuration;
        dueDate = DTL.addMonths(lastDueDate, monthCount);
    }

    function getNextDueDate(
        PayPeriodDuration periodDuration,
        uint256 maturityDate
    ) public view returns (uint256 nextDueDate) {
        if (block.timestamp >= _getStartDateOfPeriod(periodDuration, maturityDate)) {
            // The `maturityDate` becomes the next due date if the current block timestamp has surpassed the due
            // date immediately preceding the maturity date.
            return maturityDate;
        } else {
            return _getStartDateOfNextPeriod(periodDuration, block.timestamp);
        }
    }

    /// @inheritdoc ICalendar
    function getNumPeriodsPassed(
        PayPeriodDuration periodDuration,
        uint256 startDate,
        uint256 endDate
    ) public view returns (uint256 numPeriodsPassed) {
        uint256 dueDateAfterStartDate = _getStartDateOfNextPeriod(periodDuration, startDate);
        if (endDate <= dueDateAfterStartDate) {
            // `numPeriodsPassed` is 1 if the current block timestamp and the last due date are
            // within the same period.
            return 1;
        }
        // Otherwise, calculating `numPeriodsPassed` involves:
        // 1. Adding 1 to account for the time from the start date date to the next due date immediately after.
        // 2. Adding the number of complete periods that have elapsed since the previous due date.
        // 3. Adding 1 for the period that ends on `endDate`.
        // Example scenarios:
        // - If start date is 3/15 and end date is 4/15, `numPeriodsPassed` would be 2
        //   (one period for the the second half of March, one for the first half of April).
        // - For an end date of 6/2 with the same start date, `numPeriodsPassed` would be 4
        //   (second half of March, the entire April and May, and the partial period of June).
        return
            getDaysDiff(dueDateAfterStartDate, endDate) /
            _getTotalDaysInPeriod(periodDuration) +
            2;
    }

    /// @inheritdoc ICalendar
    function getMaturityDate(
        PayPeriodDuration periodDuration,
        uint256 numPeriods
    ) external view returns (uint256 maturityDate) {
        uint256 startDate = getStartOfToday();
        uint256 dayOfMonth = DTL.getDay(startDate);
        uint256 monthCount = numPeriods;
        if (dayOfMonth == 31) {
            // If the start date is on the 31st, then move it to the beginning of the next month
            // since the days diff between the 31st and the 1st of the next month is 0.
            startDate = _getStartOfNextMonth(startDate);
        }

        if (startDate != _getStartDateOfPeriod(periodDuration, startDate)) {
            // If the bill doesn't start at the beginning of the period, then we need to subtract 1 from `monthCount`
            // since both the beginning and ending periods are partial periods, and the two partial periods added
            // together forms a whole period.
            --monthCount;
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            monthCount *= 3;
        } else if (periodDuration == PayPeriodDuration.SemiAnnually) {
            monthCount *= 6;
        }
        return DTL.addMonths(startDate, monthCount);
    }

    // TODO(jiatu): not sure if the external `getStartDateOfPeriod` is useful. If it's useful, combine the two.
    // Otherwise, delete the external one.
    function _getStartDateOfPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) internal view returns (uint256 startOfPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return _getStartOfMonth(timestamp);
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return _getStartOfQuarter(timestamp);
        }
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return _getStartOfHalfYear(timestamp);
        }
        revert Errors.invalidPayPeriod();
    }

    function _getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) internal view returns (uint256 startOfNextPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return _getStartOfNextMonth(timestamp);
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return _getStartOfNextQuarter(timestamp);
        }
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return _getStartOfNextHalfYear(timestamp);
        }
        revert Errors.invalidPayPeriod();
    }

    function _getTotalDaysInPeriod(
        PayPeriodDuration periodDuration
    ) internal pure returns (uint256 totalDaysInPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return DAYS_IN_A_MONTH;
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return DAYS_IN_A_QUARTER;
        }
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return DAYS_IN_A_HALF_YEAR;
        }
        revert Errors.invalidPayPeriod();
    }

    function _getStartOfMonth(uint256 timestamp) internal pure returns (uint256 startOfMonth) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(timestamp);
        startOfMonth = DTL.timestampFromDate(year, month, 1);
        return startOfMonth;
    }

    function _getStartOfQuarter(uint256 timestamp) internal pure returns (uint256 startOfQuarter) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(timestamp);
        startOfQuarter = DTL.timestampFromDate(year, ((month - 1) / 3) * 3 + 1, 1);
        return startOfQuarter;
    }

    function _getStartOfHalfYear(
        uint256 timestamp
    ) internal pure returns (uint256 startOfHalfYear) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(timestamp);
        startOfHalfYear = DTL.timestampFromDate(year, month <= 6 ? 1 : 7, 1);
        return startOfHalfYear;
    }

    function _getStartOfNextMonth(
        uint256 timestamp
    ) internal pure returns (uint256 startOfNextMonth) {
        uint256 startOfMonth = _getStartOfMonth(timestamp);
        startOfNextMonth = DTL.addMonths(startOfMonth, 1);
        return startOfNextMonth;
    }

    function _getStartOfNextQuarter(
        uint256 timestamp
    ) internal pure returns (uint256 startOfNextQuarter) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(timestamp);
        uint256 quarter = (month - 1) / 3 + 1;
        if (quarter == 4) {
            year++;
            quarter = 1;
        } else quarter++;

        startOfNextQuarter = DTL.timestampFromDate(year, (quarter - 1) * 3 + 1, 1);
        return startOfNextQuarter;
    }

    function _getStartOfNextHalfYear(
        uint256 timestamp
    ) internal pure returns (uint256 startOfNextHalfYear) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(timestamp);
        startOfNextHalfYear = DTL.timestampFromDate(year, month > 6 ? 1 : 7, 1);
        return startOfNextHalfYear;
    }
}
