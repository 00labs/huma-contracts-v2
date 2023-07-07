// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ICalendar defines functions for date calculation
 */

interface ICalendar {
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
