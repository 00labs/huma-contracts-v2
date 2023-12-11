// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */

interface ITranchesPolicy {
    /**
     * @notice Write function of distributing loss to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param loss the loss amount
     * @param assets assets for each tranche, index 0 for senior, 1 for junior
     * @return updatedAssets updated total assets for each tranche
     * @return losses losses for each tranche
     */
    function distLossToTranches(
        uint256 loss,
        uint96[2] memory assets
    ) external returns (uint96[2] memory updatedAssets, uint96[2] memory losses);

    /**
     * @notice Write function of distributing loss recovery to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param lossRecovery the loss recovery amount
     * @param assets assets for each tranche, index 0 for senior, 1 for junior
     * @param losses losses for each tranche, index 0 for senior, 1 for junior
     * @return remainingLossRecovery the remaining loss recovery after distributing among tranches
     * @return newAssets updated total assets for each tranche, index 0 for senior, 1 for junior
     * @return newLosses updated total losses for each tranche, index 0 for senior, 1 for junior
     */
    function distLossRecoveryToTranches(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    )
        external
        returns (
            uint256 remainingLossRecovery,
            uint96[2] memory newAssets,
            uint96[2] memory newLosses
        );

    /**
     * @notice Write function of distributing profit to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param profit the profit amount
     * @param assets assets for each tranche, assets[0] for senior and assets[1] for junior
     * @return newAssets updated total assets for each tranche, index 0 for senior, 1 for junior
     */
    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets
    ) external returns (uint96[2] memory newAssets);

    /**
     * @notice Refreshes the policy data, it is used for FixedSeniorYieldTranchesPolicy to update latest senior yield data
     * @dev Accrues senior tranches yield to the current block timestamp before senior debt changes, this function won't
     * update the senior total assets which is updated when distributing profit/loss/loss recovery
     * @param assets assets for each tranche, assets[0] for senior and assets[1] for junior
     */
    function refreshData(uint96[2] memory assets) external;
}
