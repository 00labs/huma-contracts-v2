// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {ICalendar, CalendarUnit} from "./interfaces/ICalendar.sol";

import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";

contract Calendar is ICalendar {
    function getStartOfToday() external view returns (uint256 today) {}

    function getStartOfNextDay() external view returns (uint256 nextDay) {}

    function getStartOfNextMonth() external view returns (uint256 nextDay) {}

    function getStartOfNextQuarter() external view returns (uint256 nextDay) {}

    function getNextDueDate(
        CalendarUnit unit,
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        if (unit == CalendarUnit.Day) {
            return getNextDay(periodDuration, lastDueDate);
        } else if (unit == CalendarUnit.SemiMonth) {
            return getNextSemiMonth(periodDuration, lastDueDate);
        }
    }

    function getNextDay(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        if (lastDueDate == 0) {
            dueDate = block.timestamp + SECONDS_IN_A_DAY;
            (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(dueDate);
            dueDate = DTL.timestampFromDate(year, month, day);
            dueDate = DTL.addDays(dueDate, periodDuration);
        } else {
            numberOfPeriodsPassed = DTL.diffDays(lastDueDate, block.timestamp) / periodDuration;
            dueDate = DTL.addDays(lastDueDate, (numberOfPeriodsPassed + 1) * periodDuration);
        }
    }

    // TODO the start date of 7 days is different from the start date of 1 week (Bimonth has the issue), need to solve

    function getNextSemiMonth(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
        uint256 numberOfMonths;
        uint256 remainder;
        if (lastDueDate == 0) {
            numberOfMonths = periodDuration / 2;
            remainder = periodDuration - numberOfMonths * 2;
        } else {
            uint256 numberOfBiMonths = DTL.diffMonths(lastDueDate, block.timestamp) * 2;
            (uint256 yearOfLastDueDate, uint256 monthOfLastDueDate, uint256 dayOfLastDueDate) = DTL
                .timestampToDate(lastDueDate);
            if ((day < 15 && dayOfLastDueDate >= 15) || (day >= 15 && dayOfLastDueDate < 15))
                numberOfBiMonths++;
            numberOfPeriodsPassed = numberOfBiMonths / periodDuration;
            numberOfBiMonths = (numberOfPeriodsPassed + 1) * periodDuration;
            numberOfMonths = numberOfBiMonths / 2;
            remainder = numberOfBiMonths - numberOfMonths * 2;
            year = yearOfLastDueDate;
            month = monthOfLastDueDate;
            day = dayOfLastDueDate;
        }

        if (day < 15) {
            if (remainder == 0) {
                day = 15;
            } else {
                day = 1;
                (month, year) = month < 12 ? (month + 1, year) : (1, year + 1);
            }
        } else {
            if (remainder == 0) {
                day = 1;
                (month, year) = month < 12 ? (month + 1, year) : (1, year + 1);
            } else {
                day = 15;
                (month, year) = month < 12 ? (month + 1, year) : (1, year + 1);
            }
        }
        dueDate = DTL.timestampFromDate(year, month, day);
        dueDate = DTL.addMonths(dueDate, numberOfMonths);
    }
}
