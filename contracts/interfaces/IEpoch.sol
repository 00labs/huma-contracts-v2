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
     * @notice Returns the list of all unprocessed/partially processed epochs infos.
     */
    function unprocessedEpochInfos() external view returns (EpochInfo[] memory);

    /**
     * @notice Executes processed epochs
     */
    function executeEpochs(
        EpochInfo[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external;
}
