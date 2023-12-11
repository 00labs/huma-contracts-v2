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
     * @notice Returns the beginning of the next quarter.
     */
    function getStartOfNextQuarter() external view returns (uint256 startOfNextQuarter);

    /**
     * @notice Returns the beginning of the next half of the year.
     */
    function getStartOfNextHalfYear() external view returns (uint256 startOfHalfYear);

    /**
     * @notice Returns the beginning of tomorrow as a timestamp.
     */
    function getStartOfTomorrow() external view returns (uint256 startOfTomorrow);

    /**
     * @notice Returns the beginning of the next day relative to the given timestamp.
     */
    function getStartOfNextDay(uint256 timestamp) external pure returns (uint256 startOfNextDay);

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

    /**
     * @notice Returns the beginning of today
     */
    function getStartOfToday() external view returns (uint256 startOfToday);

    /**
     * @notice Returns the number of days passed and the total numbers of days of the period.
     * @dev Since we are aligning at the start of a day, the maximum number of `daysPassed` possible
     * is `totalDaysInPeriod - 1`, e.g. for a monthly period, the maximum possible `daysPassed` is 29.
     */
    function getDaysPassedInPeriod(
        PayPeriodDuration periodDuration,
        uint256 nextDueDate
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
     * @notice Returns the start date of the period specified by the timestamp.
     */
    function getStartDateOfPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfPeriod);

    /**
     * @notice Returns the start date of the immediate next period after `timestamp`.
     * If `timestamp` is 0, use the current block timestamp.
     */
    function getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfNextPeriod);

    /**
     * @notice Returns the maturity date, which is `numPeriods` number of periods after the given `timestamp`.
     * E.g. if the current block timestamp is 3/15, `periodDuration` is monthly and `numPeriods` is 3,
     * then this function should return the beginning of the day of 5/15. The three periods are 3/15 - 4/1, 4/1 - 5/1,
     * 5/1 - 5/15.
     */
    function getMaturityDate(
        PayPeriodDuration periodDuration,
        uint256 numPeriods,
        uint256 timestamp
    ) external pure returns (uint256 maturityDate);

    /**
     * @notice Returns the total number of days in a full period, e.g. 30, 90 or 180 days.
     */
    function getTotalDaysInFullPeriod(
        PayPeriodDuration periodDuration
    ) external pure returns (uint256 totalDaysInPeriod);
}
