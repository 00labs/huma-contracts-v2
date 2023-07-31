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
        } else if (unit == CalendarUnit.Month) {
            return getNextMonth(periodDuration, lastDueDate);
        }
    }

    function getNextDay(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        uint256 periodCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(dueDate);
            lastDueDate = DTL.timestampFromDate(year, month, day);
            periodCount = 1;
        } else {
            numberOfPeriodsPassed = DTL.diffDays(lastDueDate, block.timestamp) / periodDuration;
        }
        periodCount += (numberOfPeriodsPassed + 1) * periodDuration;
        dueDate = DTL.addDays(lastDueDate, periodCount);
    }

    function getNextMonth(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        uint256 periodCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, ) = DTL.timestampToDate(dueDate);
            lastDueDate = DTL.timestampFromDate(year, month, 1);
            periodCount = 1;
        } else {
            numberOfPeriodsPassed = DTL.diffMonths(lastDueDate, block.timestamp) / periodDuration;
        }
        periodCount += (numberOfPeriodsPassed + 1) * periodDuration;
        dueDate = DTL.addMonths(lastDueDate, periodCount);
    }
}
