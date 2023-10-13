// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @title IFirstLossCover
 * @notice Interface for first loss cover
 */
interface IFirstLossCover {
    /**
     * @notice Adds assets in the first loss cover
     */
    function depositCover(uint256 assets) external returns (uint256 shares);

    /**
     * @notice Withdraws excessive assets from the first loss cover.
     * The remaining assets should meet the requirements specified by poolCapCoverageInBps and poolValueCoverageInBps.
     */
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets);

    function addCoverAssets(uint256 assets) external;

    function coverLoss(uint256 loss) external returns (uint256 remainingLoss);

    function recoverLoss(uint256 recovery) external;

    function totalAssets() external view returns (uint256);

    function calcLossCover(uint256 loss) external view returns (uint256 remainingLoss);

    function calcLossRecover(
        uint256 recovery
    ) external view returns (uint256 remainingRecovery, uint256 recoveredAmount);

    function isSufficient(address account) external view returns (bool sufficient);

    function depositCoverFor(uint256 assets, address receiver) external returns (uint256 shares);
}
