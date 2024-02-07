// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

interface IEpochManager {
    /**
     * @notice Starts the next epoch. Used when a pool is created and when the system advances to the next epoch.
     * @custom:access Only the Pool contract can call this function.
     */
    function startNewEpoch() external;

    /**
     * @notice Closes current epoch, handles tranche redemption requests and starts the next epoch.
     * @dev We expect a cron-like mechanism like autotask to call this function periodically to close epochs.
     * @custom:access Anyone can call this function to trigger epoch closure, but no one will be able to
     * close an epoch prematurely.
     */
    function closeEpoch() external;

    /**
     * @notice Returns the ID of the current epoch.
     * @return The ID of the current epoch.
     */
    function currentEpochId() external view returns (uint256);
}
