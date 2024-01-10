// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @title IFirstLossCover
 * @notice Interface for first loss cover
 */
interface IFirstLossCover {
    /**
     * @notice Adds assets in the first loss cover.
     * @param assets The amount of assets to add.
     * @return shares The number of shares minted for the assets deposited.
     * @custom:access On cover providers can call this function.
     */
    function depositCover(uint256 assets) external returns (uint256 shares);

    /**
     * @notice Adds assets in the first loss cover on behalf of the receiver.
     * @notice This function is intended for the PoolFeeManager. It'll call this function to deposit fees
     * as assets into the first loss cover for the protocol owner, pool owner and EA .
     * @param assets The amount of assets to add.
     * @param receiver The receiver of the shares minted as a result of the deposit.
     * @return shares The number of shares minted for the assets deposited.
     * @custom:access Only the PoolFeeManager contract can call this function.
     */
    function depositCoverFor(uint256 assets, address receiver) external returns (uint256 shares);

    /**
     * @notice Adds pool profits to the cover as assets
     * @param assets The amount of assets to add.
     * @custom:access Only the Pool contract can call this function.
     */
    function addCoverAssets(uint256 assets) external;

    /**
     * @notice Redeems assets from the first loss cover.
     * @param shares The number of shares to redeem.
     * @param receiver The address that will receive the redeemed assets.
     * @custom:access Anyone can call this function, but they will have to burn their own shares.
     */
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets);

    /**
     * @notice Asks the first loss cover to cover the loss suffered by the pool.
     * @param loss The loss amount to be covered by the first loss cover.
     * @return remainingLoss The remaining loss after applying this cover.
     * @custom:access Only the Pool contract can call this function.
     */
    function coverLoss(uint256 loss) external returns (uint256 remainingLoss);

    /**
     * @notice Applies recovered amount to the first loss cover.
     * @param recovery The recovery amount available for distribution.
     * @return remainingRecovery The remaining recovery after applying this recover.
     * @custom:access Only the Pool contract can call this function.
     */
    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery);

    /**
     * @notice Returns the total amount of assets in the first loss cover.
     * @return The total amount of assets.
     */
    function totalAssets() external view returns (uint256);

    /**
     * @notice Returns whether the first loss cover has sufficient assets to meet
     * the minimum liquidity requirement.
     * @return sufficient Whether the first loss cover has sufficient assets.
     */
    function isSufficient() external view returns (bool sufficient);

    /**
     * @notice Returns the available capacity of the first loss cover.
     * @return availableCap The amount of available capacity.
     */
    function getAvailableCap() external view returns (uint256 availableCap);

    /**
     * @notice Returns the maximum amount of assets that the first loss cover can take.
     * @return maxLiquidity The maximum amount assets the first loss cover can take.
     */
    function getMaxLiquidity() external view returns (uint256 maxLiquidity);

    /**
     * @notice Returns the minimum amount of assets that the first loss cover can take.
     * @return minLiquidity The minimum amount assets the first loss cover can take.
     */
    function getMinLiquidity() external view returns (uint256 minLiquidity);
}
