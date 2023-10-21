// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "../SharedDefs.sol";
import {ICalendar} from "./interfaces/ICalendar.sol";

import {BokkyPooBahsDateTimeLibrary as DTL} from "./utils/BokkyPooBahsDateTimeLibrary.sol";

import "hardhat/console.sol";

//* todo change periodDuration to an enum {Monthly, Quarterly, SemiAnnually}
contract Calendar is ICalendar {
    ///@inheritdoc ICalendar
    function getStartOfThisMonth() external view returns (uint256 nextDay) {}

    ///@inheritdoc ICalendar
    function getStartOfThisQuarter() external view returns (uint256 nextDay) {}

    ///@inheritdoc ICalendar
    function getStartOfToday() external view returns (uint256 today) {}

    ///@inheritdoc ICalendar
    function getStartOfNextDay() external view returns (uint256 nextDay) {}

    ///@inheritdoc ICalendar
    function getStartOfNextMonth() external view returns (uint256 nextDay) {}

    ///@inheritdoc ICalendar
    function getStartOfNextQuarter() external view returns (uint256 nextDay) {}

    ///@inheritdoc ICalendar
    function getStartDateOfPeriod(
        uint256 periodDuration,
        uint256 periodEndDate
    ) external pure returns (uint256 startDate) {
        return DTL.subMonths(periodEndDate, periodDuration);
    }

    ///@inheritdoc ICalendar
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

    ///@inheritdoc ICalendar
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
