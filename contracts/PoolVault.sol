// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";

contract PoolVault is IPoolVault {
    struct Reserves {
        uint96 forRedemption;
        uint96 forPlatformFees;
    }

    PoolConfig public poolConfig;
    IERC20 public asset;

    Reserves public reserves;

    // TODO permission
    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig = _poolConfig;
        address assetAddress = address(poolConfig.underlyingToken());
        if (assetAddress == address(0)) revert Errors.zeroAddressProvided();
        asset = IERC20(assetAddress);
    }

    // TODO migration function

    function deposit(address from, uint256 amount) external {
        asset.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        asset.transfer(to, amount);
    }

    function addPlatformFeesReserve(uint256 reserve) external {
        Reserves memory rs = reserves;
        reserves.forPlatformFees += uint96(reserve);
        reserves = rs;
    }

    function withdrawFees(address to, uint256 amount) external {
        Reserves memory rs = reserves;
        reserves.forPlatformFees -= uint96(amount);
        reserves = rs;
        asset.transfer(to, amount);
    }

    function setRedemptionReserve(uint256 reserve) external {
        Reserves memory rs = reserves;
        reserves.forRedemption = uint96(reserve);
        reserves = rs;
    }

    function getAvailableLiquidity() external view returns (uint256 assets) {
        assets = asset.balanceOf(address(this));
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets > reserve ? assets - reserve : 0;
    }

    function getAvailableReservation() external view returns (uint256 assets) {
        assets = asset.balanceOf(address(this));
        Reserves memory rs = reserves;
        uint256 reserve = rs.forRedemption + rs.forPlatformFees;
        assets = assets < reserve ? assets : reserve;
    }
}
