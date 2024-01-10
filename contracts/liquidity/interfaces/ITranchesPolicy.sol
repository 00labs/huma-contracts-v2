// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ITranchesPolicy defines the profit sharing policy between different tranches
 */
interface ITranchesPolicy {
    /**
     * @notice Distributes profit to tranches and first loss covers.
     * @dev Passing asset value for the tranches as a parameter to make the function stateless.
     * @param profit The amount of profit to distribute.
     * @param assets The assets for each tranche, assets[0] for the senior tranche and assets[1] for the junior tranche.
     * @return profitsForTrancheVault Distributed profits for tranche vaults, index 0 for senior, 1 for junior.
     * @return profitsForFirstLossCover Distributed profits for first loss covers.
     * @custom:access Only the Pool contract can call this function.
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
     * @notice Refreshes the amount of assets and unpaid yield for the senior tranche.
     * @param assets The assets for each tranche, assets[0] for the senior tranche and assets[1] for the junior tranche.
     * @custom:access Only the PoolConfig and Pool contracts can call this function.
     */
    function refreshYieldTracker(uint96[2] memory assets) external;
}
