// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";

import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";

import "hardhat/console.sol";

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

        startOfNextQuarter = DTL.timestampFromDate(year, quarter, 1);
        return startOfNextQuarter;
    }

    /// @inheritdoc ICalendar
    function getStartOfThisMonth() public view returns (uint256 startOfMonth) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        startOfMonth = DTL.timestampFromDate(year, month, 1);
        return startOfMonth;
    }

    /// @inheritdoc ICalendar
    function getStartOfThisQuarter() external view returns (uint256 startOfQuarter) {
        (uint256 year, uint256 month, ) = DTL.timestampToDate(block.timestamp);
        startOfQuarter = DTL.timestampFromDate(year, (month - 1) / 3 + 1, 1);
        return startOfQuarter;
    }

    /// @inheritdoc ICalendar
    function getStartOfToday() external view returns (uint256 startOfToday) {
        (uint256 year, uint256 month, uint256 day) = DTL.timestampToDate(block.timestamp);
        startOfToday = DTL.timestampFromDate(year, month, day);
        return startOfToday;
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
}
