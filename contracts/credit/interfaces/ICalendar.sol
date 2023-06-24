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
}
