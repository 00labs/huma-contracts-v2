// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IFirstLossCover {
    /**
     * @notice Adds assets in the loss coverer
     * @param amount the asset amount
     */
    function addCover(uint256 amount) external;

    /**
     * @notice Withdraws excess assets from the loss coverer,
     * the left assets should meet poolCapCoverageInBps and poolValueCoverageInBps settings
     * @param amount the asset amount
     * @param receiver the address to receive the withdrawn assets
     */
    function removeCover(uint256 amount, address receiver) external;

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss);

    function calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) external view returns (uint256 remainingLoss);

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery);

    function calcLossRecover(uint256 recovery) external view returns (uint256 remainingRecovery);

    function isSufficient(address account) external view returns (bool sufficient);
}
