// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

/**
 * @notice ICreditManager provides functions about fees.
 */

interface IPlatformFeeManager {
    function distributePlatformFees(uint256 profit) external returns (uint256 remaining);

    /**
     * @notice Gets remaining profit after deducting various fees
     */
    function getRemaining(uint256 profit) external view returns (uint256 remaining);
}
