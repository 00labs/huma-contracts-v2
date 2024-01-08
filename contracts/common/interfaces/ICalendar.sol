// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PayPeriodDuration} from "../SharedDefs.sol";

/**
 * @notice ICalendar defines functions for date calculation. All inputs and outputs are in UTC.
 */

interface ICalendar {
    /**
     * @notice Returns the number of days remaining in the period that ends on `endDate`.
     */
    function getDaysRemainingInPeriod(
        uint256 endDate
    ) external view returns (uint256 daysRemaining);

    /**
     * @notice Returns the number of periods passed between the two given dates.
     * @notice This function returns whole periods passed. However, if the first period is
     * a partial period, it is counted as a whole period as well.
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
     * @notice Returns the number of days between the two given dates. If `startDate` is 0, then
     * use the current block timestamp as the start date.
     * @dev The result should exclude the end date, e.g. the number of days between 1/1 and 1/2 is 1, not 2.
     */
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) external view returns (uint256 daysDiff);

    /**
     * @notice Returns the beginning of the next day relative to the given timestamp.
     */
    function getStartOfNextDay(uint256 timestamp) external pure returns (uint256 startOfNextDay);

    /**
     * @notice Returns the exact number of days between the start of the previous period given by `numPeriodsPassed`
     * and the given timestamp.
     * @notice This function counts the number of days as-is instead of using the 30/360 convention.
     * @dev The result should exclude the end date, e.g. the number of days between 1/1 and 1/2 is 1, not 2.
     */
    function getDaysDiffSincePreviousPeriodStart(
        PayPeriodDuration periodDuration,
        uint256 numPeriodsPassed,
        uint256 timestamp
    ) external pure returns (uint256 daysDiff);

    /**
     * @notice Returns the total number of days in a full period, e.g. 30, 90 or 180 days.
     */
    function getTotalDaysInFullPeriod(
        PayPeriodDuration periodDuration
    ) external pure returns (uint256 totalDaysInPeriod);
}
