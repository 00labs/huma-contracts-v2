// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct EpochInfo {
    uint64 epochId;
    uint96 totalShareRequested; // the total requested shares of this epoch
    uint96 totalShareProcessed; // the total processed shares of this epoch
    uint96 totalAmountProcessed; // the total processed amounts(according to processed shares and price) of this epoch
}

interface IEpoch {
    function unprocessedEpochInfos() external view returns (EpochInfo[] memory);

    function closeEpoch(
        EpochInfo[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external;
}
