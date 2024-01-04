// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IEpochManager {
    function currentEpochId() external view returns (uint256);

    /**
     * @notice Finishes processing the current epoch, closes it and starts the next epoch.
     */
    function closeEpoch() external;

    /**
     * @notice Starts the next epoch, used when a pool is created and when the system advances to the next epoch.
     */
    function startNewEpoch() external;
}
