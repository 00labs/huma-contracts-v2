// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "../../common/PoolConfig.sol";

/**
 * @title IFirstLossCover
 * @notice Interface for first loss cover
 */
interface IFirstLossCover {
    function initialize(string memory name, string memory symbol, PoolConfig _poolConfig) external;

    /**
     * @notice Adds assets in the first loss cover
     */
    function depositCover(uint256 assets) external returns (uint256 shares);

    /**
     * @notice Adds the cover by pool contracts, PoolFeeManager will call it to deposit fees of
     * protocol owner, pool owner and/or EA.
     */
    function depositCoverFor(uint256 assets, address receiver) external returns (uint256 shares);

    /**
     * @notice Adds to the cover using its profit.
     * @dev Only pool can call this function
     */
    function addCoverAssets(uint256 assets) external;

    /**
     * @notice Cover provider redeems from the pool
     * @param shares the number of shares to be redeemed
     * @param receiver the address to receive the redemption assets
     * @dev Anyone can call this function, but they will have to burn their own shares
     */
    function redeemCover(uint256 shares, address receiver) external returns (uint256 assets);

    /**
     * @notice Applies loss against the first loss cover
     * @param loss the loss amount to be covered by the loss cover or reported as default
     * @return remainingLoss the remaining loss after applying this cover
     */
    function coverLoss(uint256 loss) external returns (uint256 remainingLoss);

    /**
     * @notice Applies recovered amount to this first loss cover
     * @param recovery the recovery amount available for distribution to this cover
     * and other covers that are more junior than this one.
     * @return remainingRecovery the remaining recovery after applying this recover
     * @dev Only pool contract tied with the cover can call this function.
     */
    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery);

    function totalAssets() external view returns (uint256);

    /**
     * @notice Returns whether the first loss cover has sufficient assets to meet
     * the minimum liquidity requirement.
     */
    function isSufficient() external view returns (bool sufficient);

    /**
     * @notice Returns the available capacity of the given first loss cover.
     */
    function getAvailableCap() external view returns (uint256 availableCap);

    function getMaxLiquidity() external view returns (uint256 maxLiquidity);

    function getMinLiquidity() external view returns (uint256 minLiquidity);
}
