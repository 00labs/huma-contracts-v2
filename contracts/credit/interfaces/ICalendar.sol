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

    function getStartDateOfPeriod(
        CalendarUnit unit,
        uint256 periodDuration,
        uint256 periodEndDate
    ) external view returns (uint256 startDate);

    /**
     * @notice Get the next due date and the number of periods passed.
     * When lastDueDate is zero, always returns the due date after a full period from
     * the current time. For example, for a monthly period, if the first drawdown
     * happens on 7/27, the due date is 9/1 00:00:00.
     * @dev For bimonthly, the beginning is always 1st & 15th
     * @dev Timezone: always UTC
     */
    function getNextDueDate(
        CalendarUnit unit,
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed);

    function getBeginOfPeriod(
        CalendarUnit unit,
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed);

    function getNextPeriod(
        CalendarUnit unit,
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDateInNextPeriod);
}
