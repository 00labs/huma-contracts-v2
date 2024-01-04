// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */

interface ITranchesPolicy {
    /**
     * @notice Distributes profit to tranches
     * @dev Passing asset value for the tranches as a parameter to make the function stateless
     * @param profit the profit amount
     * @param assets assets for each tranche, assets[0] for senior and assets[1] for junior
     * @return profitsForTrancheVault distributed profits for tranche vaults, index 0 for senior, 1 for junior
     * @return profitsForFirstLossCover distributed profits for first loss covers
     */
    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets
    )
        external
        returns (
            uint256[2] memory profitsForTrancheVault,
            uint256[] memory profitsForFirstLossCover
        );

    /**
     * @notice Refreshes the policy yield tracker, it is used for FixedSeniorYieldTranchesPolicy to update latest senior yield data
     * @dev Accrues senior tranches yield to the current block timestamp before senior debt changes, this function won't
     * update the senior total assets which is updated when distributing profit/loss/loss recovery
     * @param assets assets for each tranche, assets[0] for senior and assets[1] for junior
     */
    function refreshYieldTracker(uint96[2] memory assets) external;
}
