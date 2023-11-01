// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct EpochInfo {
    uint64 epochId;
    uint96 totalSharesRequested; // The total number of shares requested for redemption in this epoch
    uint96 totalSharesProcessed; // The total number of shares processed for redemption in this epoch
    uint96 totalAmountProcessed; // The total amount redeemed (according to the processed shares and price) in this epoch
}

interface IEpoch {
    /**
     * @notice Returns unprocessed epoch info.
     */
    function currentEpochInfo() external view returns (EpochInfo memory);

    /**
     * @notice Executes processed epoch
     */
    function executeEpoch(EpochInfo memory epochProcessed) external;
}
