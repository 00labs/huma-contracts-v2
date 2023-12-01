// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DAYS_IN_A_MONTH, DAYS_IN_A_QUARTER, DAYS_IN_A_HALF_YEAR} from "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";
import {PayPeriodDuration} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

import "hardhat/console.sol";

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
        return _getStartOfDay(block.timestamp);
    }

    /// @inheritdoc ICalendar
    function getDaysPassedInPeriod(
        PayPeriodDuration periodDuration,
        uint256 nextDueDate
    ) external view returns (uint256 daysPassed, uint256 totalDaysInPeriod) {
        if (block.timestamp > nextDueDate) {
            revert Errors.startDateLaterThanEndDate();
        }
        uint256 day = DTL.getDay(block.timestamp);
        // If the day falls on the 31st, move it back to the 30th.
        day = day > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : day;
        uint256 periodStartDate = getStartDateOfPeriod(periodDuration, block.timestamp);
        uint256 numMonthsPassed = DTL.diffMonths(periodStartDate, block.timestamp);
        // -1 here since we are using the beginning of the day.
        daysPassed = numMonthsPassed * DAYS_IN_A_MONTH + day - 1;
        return (daysPassed, getDaysDiff(periodStartDate, nextDueDate));
    }

    /// @inheritdoc ICalendar
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) public view returns (uint256 daysDiff) {
        if (startDate > endDate) {
            revert Errors.startDateLaterThanEndDate();
        }
        if (startDate == 0) {
            startDate = block.timestamp;
        }

        (uint256 startYear, uint256 startMonth, uint256 startDay) = DTL.timestampToDate(startDate);
        (uint256 endYear, uint256 endMonth, uint256 endDay) = DTL.timestampToDate(endDate);
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
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return _getStartOfHalfYear(timestamp);
        }
        revert Errors.invalidPayPeriod();
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
    function getNumPeriodsPassed(
        PayPeriodDuration periodDuration,
        uint256 startDate,
        uint256 endDate
    ) public view returns (uint256 numPeriodsPassed) {
        if (startDate > endDate) {
            revert Errors.startDateLaterThanEndDate();
        }
        if (startDate == endDate) {
            return 0;
        }
        // There is one period at the beginning no matter whether the first period is
        // a partial period or not, so push the start date to the beginning of the period
        // to simplify the calculation.
        startDate = getStartDateOfPeriod(periodDuration, startDate);
        console.log(
            "startDate %d, endDate %d, daysDiff %d",
            startDate,
            endDate,
            getDaysDiff(startDate, endDate)
        );
        numPeriodsPassed =
            getDaysDiff(startDate, endDate) /
            getTotalDaysInFullPeriod(periodDuration);
        if (endDate != getStartDateOfPeriod(periodDuration, endDate)) {
            // If the end date is in the middle of a period, then we need to account for the
            // last partial period.
            ++numPeriodsPassed;
        }
        return numPeriodsPassed;
    }

    /// @inheritdoc ICalendar
    function getMaturityDate(
        PayPeriodDuration periodDuration,
        uint256 numPeriods,
        uint256 timestamp
    ) external view returns (uint256 maturityDate) {
        // The first period may be a partial period, so advance to the next period and only count full
        // periods.
        uint256 startDate = _getStartDateOfNextPeriod(periodDuration, timestamp);
        uint256 monthCount = numPeriods - 1;
        if (periodDuration == PayPeriodDuration.Quarterly) {
            monthCount *= 3;
        } else if (periodDuration == PayPeriodDuration.SemiAnnually) {
            monthCount *= 6;
        }
        return DTL.addMonths(startDate, monthCount);
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
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return _getStartOfNextHalfYear(timestamp);
        }
        revert Errors.invalidPayPeriod();
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
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return DAYS_IN_A_HALF_YEAR;
        }
        revert Errors.invalidPayPeriod();
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
