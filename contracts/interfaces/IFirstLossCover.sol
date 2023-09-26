// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IFirstLossCover {
    /**
     * @notice Adds assets in the first loss cover

     */
    function depositCover(uint256 assets) external returns (uint256 shares);

    /**
     * @notice Withdraws excess assets from the first loss cover.
     * The remaining assets should meet the requirements specified by poolCapCoverageInBps and poolValueCoverageInBps.
     */
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets);

    function distributeProfit(uint256 profit) external;

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss);

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery);

    function totalAssets() external view returns (uint256);

    function calcLossCover(
        uint256 poolAssets,
        uint256 loss
    ) external view returns (uint256 remainingLoss);

    function calcLossRecover(uint256 recovery) external view returns (uint256 remainingRecovery);

    function isSufficient(address account) external view returns (bool sufficient);

    function availableLiquidityCapacity() external view returns (uint256);

    function depositCoverWithAffiliateFees(
        uint256 assets,
        address receiver
    ) external returns (uint256 shares);
}
