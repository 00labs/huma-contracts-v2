// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ILossCoverer {
    function coverLoss(uint256 loss) external view returns (uint256 remainingLoss);

    function recoverLoss(uint256 recovery) external view returns (uint256 remainingRecovery);
}
