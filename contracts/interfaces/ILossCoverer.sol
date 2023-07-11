// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ILossCoverer {
    function removeLiquidity(address receiver) external;

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss);

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery);

    function isSufficient() external view returns (bool sufficient);
}
