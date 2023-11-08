// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PayPeriodDuration} from "../CreditStructs.sol";

/**
 * @notice ICalendar defines functions for date calculation. All inputs and outputs are in UTC.
 */

interface ICalendar {
    /**
     * @notice Returns the beginning of the next month
     */
    function getStartOfNextMonth() external view returns (uint256 startOfNextMonth);

    /**
     * @notice Returns the beginning of the next half of the year.
     */
    function getStartOfNextHalfYear() external view returns (uint256 startOfHalfYear);

    /**
     * @notice Returns the beginning of tomorrow as a timestamp.
     */
    function getStartOfTomorrow() external view returns (uint256 startOfTomorrow);

    /**
     * @notice Returns the beginning of this month
     */
    function getStartOfThisMonth() external view returns (uint256 startOfMonth);

    /**
     * @notice Returns the beginning of this quarter
     */
    function getStartOfThisQuarter() external view returns (uint256 startOfQuarter);

    /**
     * @notice Returns the beginning of this half of the year. i.e. 1/1 or 7/1.
     */
    function getStartOfThisHalfYear() external view returns (uint256 startOfHalfYear);

    function getStartOfNextQuarter() external view returns (uint256 nstartOfNextQuarterextDay);

    /**
     * @notice Returns the beginning of today
     */
    function getStartOfToday() external view returns (uint256 startOfToday);

    /**
     * @notice Returns the number of days passed and the total numbers of days of the period
     */
    function getDaysPassedInPeriod(
        PayPeriodDuration periodDuration
    ) external view returns (uint256 daysPassed, uint256 totalDaysInPeriod);

    /**
     * @notice Returns the number of days between the two given dates. If `startDate` is 0, then
     * use the current block timestamp as the start date.
     * @dev The result should exclude the end date, e.g. the number of days between 1/1 and 1/2 is 1, not 2.
     */
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) external view returns (uint256 daysDiff);

    /**
     * @notice Returns the number of periods passed between the two given dates.
     */
    function getNumPeriodsPassed(
        PayPeriodDuration periodDuration,
        uint256 startDate,
        uint256 endDate
    ) external view returns (uint256 numPeriodsPassed);

    /**
     * @notice Returns the start date of the period specified by the end date.
     */
    function getStartDateOfPeriod(
        uint256 periodDuration,
        uint256 periodEndDate
    ) external view returns (uint256 startDate);

    /**
     * @notice Returns the start date of the immediate next period after `timestamp`.
     * If `timestamp` is 0, use the current block timestamp.
     */
    function getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfNextPeriod);

    /**
     * @notice Returns the next due date relative to the current block timestamp. If the current block
     * is within the last pay period or has surpassed the maturity date, then returns the maturity date
     * as the next due date.
     */
    function getNextDueDate(
        PayPeriodDuration periodDuration,
        uint256 maturityDate
    ) external view returns (uint256 nextDueDate);

    function getNextDueDate(
        uint256 periodDuration,
        uint256 lastDueDate
    ) external view returns (uint256 dueDate, uint256 numberOfPeriodsPassed);
}
