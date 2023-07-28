// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CalendarUnit} from "../CreditStructs.sol";

/**
 * @notice ICalendar defines functions for date calculation
 */

interface ICalendar {
    /**
     * @notice Get the beginning of today
     */
    function getStartOfToday() external view returns (uint256 today);

    /**
     * @notice Get the beginning of the next day
     */
    function getStartOfNextDay() external view returns (uint256 nextDay);

    /**
     * @notice Get the beginning of the next month
     */
    function getStartOfNextMonth() external view returns (uint256 nextDay);

    /**
     * @notice Get the beginning of the next quarter
     */
    function getStartOfNextQuarter() external view returns (uint256 nextDay);

    /**
     * @notice Get the number of pay period passed
     */
    function getNumberOfPeriodsPassed(
        CalendarUnit calendarUnit,
        uint16 periodDuration,
        uint64 nextDueDate
    ) external view returns (uint256 nextDay);

    function getNextDueDate(
        uint256 lastDueDate,
        CalendarUnit unit,
        uint256 periodDuration
    ) external pure returns (uint256 dueDate);

    /**
     * @notice Get next due date.
     * @param params params
     * params[0] - the loan start timestamp
     * params[1] - last updated timestamp
     * params[2] - number of period
     * params[3] - optional, the duraion of one period in days
     * @return dueDate next due date
     */
    function getNextDueDate(uint256[] memory params) external view returns (uint256 dueDate);
    //todo .We may want to include both due date and the date with grace period.

    //todo We may want to add a getDefaultEligibleDate() to return the first date that a default can be triggered
}
