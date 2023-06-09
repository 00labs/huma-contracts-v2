// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IScheduleStrategy {
    function getNextDueDate(uint256[] memory params) external view returns (uint256);
}
