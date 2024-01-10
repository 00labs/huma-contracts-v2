// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DAYS_IN_A_MONTH, DAYS_IN_A_QUARTER, DAYS_IN_A_HALF_YEAR} from "../common/SharedDefs.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {BokkyPooBahsDateTimeLibrary as DTL} from "../common/utils/BokkyPooBahsDateTimeLibrary.sol";
import {PayPeriodDuration} from "../common/SharedDefs.sol";
import {Errors} from "../common/Errors.sol";

/**
 * @notice We use the 30/360 day count convention in this implementation, which treats every month as having 30 days
 * and every year as having 360 days, regardless of the actual number of days in a month/year. This is a common
 * practice in corporate finance.
 */
contract Calendar is ICalendar {
    /// @inheritdoc ICalendar
    function getDaysRemainingInPeriod(
        uint256 endDate
    ) external view returns (uint256 daysRemaining) {
        if (block.timestamp > endDate) {
            revert Errors.StartDateLaterThanEndDate();
        }
        uint256 day = DTL.getDay(block.timestamp);
        // If the day falls on the 31st, move it back to the 30th.
        day = day > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : day;
        uint256 startDateOfMonth = _getStartOfMonth(block.timestamp);
        uint256 numMonths = DTL.diffMonths(startDateOfMonth, endDate);
        if (numMonths == 0) {
            // This happens if block.timestamp happens to be the same as the end date.
            return 0;
        }
        // +1 here since we are using the beginning of the day.
        return numMonths * DAYS_IN_A_MONTH - day + 1;
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
    function getStartOfNextDay(uint256 timestamp) external pure returns (uint256 startOfNextDay) {
        return DTL.addDays(_getStartOfDay(timestamp), 1);
    }

    /// @inheritdoc ICalendar
    function getDaysDiffSincePreviousPeriodStart(
        PayPeriodDuration periodDuration,
        uint256 numPeriodsPassed,
        uint256 timestamp
    ) external pure returns (uint256 daysDiff) {
        uint256 periodStartDate = getStartDateOfPeriod(periodDuration, timestamp);
        uint256 numMonths = numPeriodsPassed;
        if (periodDuration == PayPeriodDuration.Quarterly) {
            numMonths *= 3;
        } else if (periodDuration == PayPeriodDuration.SemiAnnually) {
            numMonths *= 6;
        }
        uint256 startDate = DTL.subMonths(periodStartDate, numMonths);
        return DTL.diffDays(startDate, timestamp);
    }

    /// @inheritdoc ICalendar
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) public view returns (uint256 daysDiff) {
        if (startDate > endDate) {
            revert Errors.StartDateLaterThanEndDate();
        }
        if (startDate == 0) {
            startDate = block.timestamp;
        }

        (uint256 startYear, uint256 startMonth, uint256 startDay) = DTL.timestampToDate(startDate);
        (uint256 endYear, uint256 endMonth, uint256 endDay) = DTL.timestampToDate(endDate);
        // If the day falls on the 31st, move it back to the 30th.
        startDay = startDay > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : startDay;
        endDay = endDay > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : endDay;
        if (startYear == endYear && startMonth == endMonth) {
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
    function getNumPeriodsPassed(
        PayPeriodDuration periodDuration,
        uint256 startDate,
        uint256 endDate
    ) public view returns (uint256 numPeriodsPassed) {
        if (startDate > endDate) {
            revert Errors.StartDateLaterThanEndDate();
        }
        if (startDate == endDate) {
            return 0;
        }
        // There is one period at the beginning no matter whether the first period is
        // a partial period or not, so push the start date to the beginning of the period
        // to simplify the calculation.
        startDate = getStartDateOfPeriod(periodDuration, startDate);
        return getDaysDiff(startDate, endDate) / getTotalDaysInFullPeriod(periodDuration);
    }

    /// @inheritdoc ICalendar
    function getStartDateOfPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) public pure returns (uint256 startOfPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return _getStartOfMonth(timestamp);
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return _getStartOfQuarter(timestamp);
        }
        return _getStartOfHalfYear(timestamp);
    }

    /// @inheritdoc ICalendar
    function getTotalDaysInFullPeriod(
        PayPeriodDuration periodDuration
    ) public pure returns (uint256 totalDaysInPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return DAYS_IN_A_MONTH;
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return DAYS_IN_A_QUARTER;
        }
        return DAYS_IN_A_HALF_YEAR;
    }

    function _getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) internal pure returns (uint256 startOfNextPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return _getStartOfNextMonth(timestamp);
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return _getStartOfNextQuarter(timestamp);
        }
        return _getStartOfNextHalfYear(timestamp);
    }

    function _getStartOfDay(uint256 timestamp) internal pure returns (uint256 startOfDay) {
        (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(timestamp);
        return DTL.timestampFromDate(year, month, day);
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
