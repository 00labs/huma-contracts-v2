// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PayPeriodDuration} from "../SharedDefs.sol";

/**
 * @notice ICalendar defines functions for date calculation. All inputs and outputs are in UTC.
 */
interface ICalendar {
    /**
     * @notice Returns the number of days remaining in the period that ends on endDate.
     * @param endDate The end date of the period. Note that passing in dates other than the end date will not work.
     * @return daysRemaining The number of days remaining in the period.
     */
    function getDaysRemainingInPeriod(
        uint256 endDate
    ) external view returns (uint256 daysRemaining);

    /**
     * @notice Returns the number of periods passed between the two given dates.
     * @notice This function returns whole periods passed. However, if the first period is
     * a partial period, it is counted as a whole period as well.
     * @param periodDuration The pay period duration, e.g. monthly, quarterly and semi-annually.
     * @param startDate The date on which the counting should start.
     * @param endDate The date on which the counting should end.
     * @return numPeriodsPassed The number of periods passed between the start and end dates.
     */
    function getNumPeriodsPassed(
        PayPeriodDuration periodDuration,
        uint256 startDate,
        uint256 endDate
    ) external view returns (uint256 numPeriodsPassed);

    /**
     * @notice Returns the start date of the period specified by the timestamp. E.g. if the timestamp represents Feb 15,
     * and the period duration is monthly, then this function should return Feb 1.
     * @param periodDuration The pay period duration, e.g. monthly, quarterly and semi-annually.
     * @param timestamp The timestamp that the calculation will be based on.
     * @return startOfPeriod The start date of the period that the given timestamp is in.
     */
    function getStartDateOfPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfPeriod);

    /**
     * @notice Returns the start date of the immediate next period after timestamp.
     * @dev If timestamp is 0, use the current block timestamp.
     * @param periodDuration The pay period duration, e.g. monthly, quarterly and semi-annually.
     * @param timestamp The timestamp that the calculation will be based on.
     * @return startOfNextPeriod The start date of the next period immediately after the timestamp.
     */
    function getStartDateOfNextPeriod(
        PayPeriodDuration periodDuration,
        uint256 timestamp
    ) external view returns (uint256 startOfNextPeriod);

    /**
     * @notice Returns the number of days between the two given dates. If startDate is 0, then
     * use the current block timestamp as the start date.
     * @dev The result should exclude the end date, e.g. the number of days between 1/1 and 1/2 is 1, not 2.
     * @param startDate The date on which the counting should start.
     * @param endDate The date on which the counting should end.
     * @return daysDiff The number of days elapsed between the start and end dates.
     */
    function getDaysDiff(
        uint256 startDate,
        uint256 endDate
    ) external view returns (uint256 daysDiff);

    /**
     * @notice Returns the beginning of the next day relative to the given timestamp.
     * @param timestamp The timestamp that the calculation will be based on.
     * @return startOfNextDay The start of the next day relative to timestamp.
     */
    function getStartOfNextDay(uint256 timestamp) external pure returns (uint256 startOfNextDay);

    /**
     * @notice Returns the exact number of days between the start of the previous period given by numPeriodsPassed
     * and the given timestamp.
     * @notice This function should count the number of days as-is even if the implementation uses the 30/360
     * convention. E.g. If timestamp is May 10, the numPeriodPassed is 2, and the period duration is monthly,
     * then this function should return 70 (31 days in Mar, 30 days in Apr, and 9 days from May 1 - May 10).
     * @dev The result should exclude the end date, e.g. the number of days between 1/1 and 1/2 is 1, not 2.
     * @param periodDuration The pay period duration, e.g. monthly, quarterly and semi-annually.
     * @param numPeriodsPassed The number of periods passed since the beginning of the period we are interested in.
     * @param timestamp The timestamp that the calculation will be based on.
     * @return daysDiff The exact number of days between the start of the previous period given by numPeriodsPassed
     * and the given timestamp.
     */
    function getDaysDiffSincePreviousPeriodStart(
        PayPeriodDuration periodDuration,
        uint256 numPeriodsPassed,
        uint256 timestamp
    ) external pure returns (uint256 daysDiff);

    /**
     * @notice Returns the total number of days in a full period, e.g. 30, 90 or 180 days.
     * @param periodDuration The pay period duration, e.g. monthly, quarterly and semi-annually.
     * @return totalDaysInPeriod The total number of days in a full period.
     */
    function getTotalDaysInFullPeriod(
        PayPeriodDuration periodDuration
    ) external pure returns (uint256 totalDaysInPeriod);
}
