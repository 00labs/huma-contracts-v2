// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DAYS_IN_A_MONTH, DAYS_IN_A_QUARTER, DAYS_IN_A_HALF_YEAR} from "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";
import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";
import {PayPeriodDuration} from "./CreditStructs.sol";
import {Errors} from "../Errors.sol";

//* todo change periodDuration to an enum {Monthly, Quarterly, SemiAnnually}
contract Calendar is ICalendar {
    /// @inheritdoc ICalendar
    function getStartOfNextMonth() external view returns (uint256 startOfNextMonth) {
        uint256 startOfMonth = getStartOfThisMonth();
        startOfNextMonth = DTL.addMonths(startOfMonth, 1);
        return startOfNextMonth;
    }

    /// @inheritdoc ICalendar
    function getStartOfNextQuarter() external view returns (uint256 startOfNextQuarter) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        uint256 quarter = (month - 1) / 3 + 1;
        if (quarter == 4) {
            year++;
            quarter = 1;
        } else quarter++;

        startOfNextQuarter = DTL.timestampFromDate(year, (quarter - 1) * 3 + 1, 1);
        return startOfNextQuarter;
    }

    /// @inheritdoc ICalendar
    function getStartOfTomorrow() external view returns (uint256 startOfTomorrow) {
        return DTL.addDays(getStartOfToday(), 1);
    }

    /// @inheritdoc ICalendar
    function getStartOfThisMonth() public view returns (uint256 startOfMonth) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        startOfMonth = DTL.timestampFromDate(year, month, 1);
        return startOfMonth;
    }

    /// @inheritdoc ICalendar
    function getStartOfThisQuarter() public view returns (uint256 startOfQuarter) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        startOfQuarter = DTL.timestampFromDate(year, ((month - 1) / 3) * 3 + 1, 1);
        return startOfQuarter;
    }

    /// @inheritdoc ICalendar
    function getStartOfThisHalfYear() public view returns (uint256 startOfHalfYear) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        startOfHalfYear = DTL.timestampFromDate(year, month <= 6 ? 1 : 7, 1);
        return startOfHalfYear;
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
    ) external view returns (uint256 daysPassed, uint256 totalDaysInPeriod) {
        uint256 day = DTL.getDay(block.timestamp);
        // If the day falls on the 31st, move it back to the 30th.
        day = day > DAYS_IN_A_MONTH ? DAYS_IN_A_MONTH : day;
        uint256 startOfPeriod = _getStartDateOfPeriod(periodDuration);
        uint256 numMonthsPassed = DTL.diffMonths(startOfPeriod, block.timestamp);
        daysPassed = numMonthsPassed * DAYS_IN_A_MONTH + day;
        return (daysPassed, _getTotalDaysInPeriod(periodDuration));
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
    function getNextPeriod(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 nextDueDate) {
        uint256 monthCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, 1);
            monthCount = 1;
        }
        monthCount += periodDuration;
        nextDueDate = DTL.addMonths(lastDueDate, monthCount);
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

    // TODO(jiatu): not sure if the external `getStartDateOfPeriod` is useful. If it's useful, combine the two.
    // Otherwise, delete the external one.
    function _getStartDateOfPeriod(
        PayPeriodDuration periodDuration
    ) internal view returns (uint256 startOfPeriod) {
        if (periodDuration == PayPeriodDuration.Monthly) {
            return getStartOfThisMonth();
        }
        if (periodDuration == PayPeriodDuration.Quarterly) {
            return getStartOfThisQuarter();
        }
        if (periodDuration == PayPeriodDuration.SemiAnnually) {
            return getStartOfThisHalfYear();
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
}
