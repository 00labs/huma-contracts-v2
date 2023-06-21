// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct EpochInfo {
    uint64 epochId;
    uint96 totalRequestedWithdrawalAmount;
    uint96 totalProcessedWithdrawalAmount;
    uint96 totalProcessedRedeemShare;
}

interface ITrancheVault {
    function totalSupply() external view returns (uint256);

    function unprocessedEpochInfos() external view returns (EpochInfo[] memory);

    function closeEpoch(EpochInfo[] memory processedEpochs) external;
}
