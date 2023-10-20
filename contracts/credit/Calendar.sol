// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";

import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";

import "hardhat/console.sol";

contract Calendar is ICalendar {
    function getStartOfToday() external view returns (uint256 today) {}

    function getStartOfNextDay() external view returns (uint256 nextDay) {}

    function getStartOfNextMonth() external view returns (uint256 nextDay) {}

    function getStartOfNextQuarter() external view returns (uint256 nextDay) {}

    function getStartDateOfPeriod(
        uint256 periodDuration,
        uint256 periodEndDate
    ) external pure returns (uint256 startDate) {
        return DTL.subMonths(periodEndDate, periodDuration);
    }

    /**
     * @notice Gets the immediate next due date following lastDueDate. If multiple periods have
     * passed since lastDueDate, this function returns the due date that is only one period after
     * lastDueDate. In contract, getNextDueDate() gets the next due date based on block.timestamp.
     */
    function getNextPeriod(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDateInNextPeriod) {
            return getNextPeriodInMonths(periodDuration, lastDueDate);
    }

    function getBeginOfPeriod(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
            return getDueDateInMonths(periodDuration, lastDueDate, false);
    }

    function getNextDueDate(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
            return getDueDateInMonths(periodDuration, lastDueDate, true);
    }

    function getNextPeriodInDays(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 nextDueDate) {
        uint256 dayCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, day);
            dayCount = 1;
        }
        dayCount += periodDuration;
        nextDueDate = DTL.addDays(lastDueDate, dayCount);
    }

    function getNextPeriodInMonths(
        uint256 periodDuration,
        uint256 lastDueDate
    ) internal view returns (uint256 nextDueDate) {
        uint256 monthCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, 1);
            monthCount = 1;
        }
        monthCount += periodDuration;
        nextDueDate = DTL.addMonths(lastDueDate, monthCount);
    }

    function getDueDateInDays(
        uint256 periodDuration,
        uint256 lastDueDate,
        bool isNext
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        uint256 dayCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, day);
            dayCount = 1;
        } else {
            numberOfPeriodsPassed = DTL.diffDays(lastDueDate, block.timestamp) / periodDuration;
        }
        if (isNext) dayCount += (numberOfPeriodsPassed + 1) * periodDuration;
        else dayCount += numberOfPeriodsPassed * periodDuration;
        dueDate = DTL.addDays(lastDueDate, dayCount);
    }

    /**
     * @param isNext whether to get the next due date. When it is false, returns the beginning of the current period.
     */
    function getDueDateInMonths(
        uint256 periodDuration,
        uint256 lastDueDate,
        bool isNext
    ) internal view returns (uint256 dueDate, uint256 numberOfPeriodsPassed) {
        uint256 monthCount;
        if (lastDueDate == 0) {
            (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
            lastDueDate = DTL.timestampFromDate(year, month, 1);
            monthCount = 1;
        } else {
            numberOfPeriodsPassed = DTL.diffMonths(lastDueDate, block.timestamp) / periodDuration;
        }
        if (isNext) monthCount += (numberOfPeriodsPassed + 1) * periodDuration;
        else monthCount += numberOfPeriodsPassed * periodDuration;
        dueDate = DTL.addMonths(lastDueDate, monthCount);
    }
}
