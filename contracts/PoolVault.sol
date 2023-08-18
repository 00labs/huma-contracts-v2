// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";

contract PoolVault is PoolConfigCache, IPoolVault {
    struct Reserves {
        uint96 forRedemption;
        uint96 forPlatformFees;
    }

    IERC20 public asset;
    Reserves public reserves;

    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address assetAddress = _poolConfig.underlyingToken();
        if (assetAddress == address(0)) revert Errors.zeroAddressProvided();
        asset = IERC20(assetAddress);
    }

    function deposit(address from, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrLossCovererOrCredit(msg.sender);

        asset.transferFrom(from, address(this), amount);
    }

    function withdraw(address to, uint256 amount) external {
        poolConfig.onlyTrancheVaultOrLossCovererOrCredit(msg.sender);

        asset.transfer(to, amount);
    }

    function addPlatformFeesReserve(uint256 reserve) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        reserves.forPlatformFees += uint96(reserve);
        reserves = rs;
    }

    function withdrawFees(address to, uint256 amount) external {
        poolConfig.onlyPlatformFeeManager(msg.sender);

        Reserves memory rs = reserves;
        reserves.forPlatformFees -= uint96(amount);
        reserves = rs;
        asset.transfer(to, amount);
    }

    function setRedemptionReserve(uint256 reserve) external {
        poolConfig.onlyPool(msg.sender);

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

    function totalAssets() external view returns (uint256 assets) {
        return asset.balanceOf(address(this));
    }
}
